// Test helpers: load TaskTape's real files into simulated pages (jsdom) or a simulated background,
// with a fake `chrome` API. Run with: npm test
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
let group = "";
function section(name) { group = name; console.log(`\n${name}`); }
function ok(condition, message) {
  console.log(`  ${condition ? "✓" : "✗ FAIL"} ${message}`);
  if (!condition) failures += 1;
}
const failed = () => failures;

// ───────────── Web page with content.js ─────────────
function contentPage(html, { trustEvents = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.CSS = { escape: (s) => String(s).replace(/([^a-zA-Z0-9_-])/g, "\\$1") };
  w.Element.prototype.scrollIntoView = () => {};
  if (!w.PointerEvent) w.PointerEvent = w.MouseEvent;
  // jsdom lacks DataTransfer and a writable FileList: minimal stand-ins.
  w.DataTransfer = class { constructor() { const files = []; this.files = files; this.items = { add: (f) => files.push(f) }; } };
  Object.defineProperty(w.HTMLInputElement.prototype, "files", { get() { return this._files || []; }, set(v) { this._files = v; }, configurable: true });
  w.HTMLFormElement.prototype.requestSubmit = function () { this.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); };
  const sent = [];
  const listeners = [];
  w.chrome = { runtime: { id: "test", lastError: null, sendMessage: (m, cb) => { sent.push(m); if (cb) cb(null); }, onMessage: { addListener: (f) => listeners.push(f) } } };
  if (trustEvents) {
    // jsdom events are untrusted; the recorder only records trusted (real user) events.
    const original = w.document.addEventListener.bind(w.document);
    w.document.addEventListener = (type, fn, options) => original(type, (e) => fn(new Proxy(e, {
      get(target, prop) { if (prop === "isTrusted") return true; const v = target[prop]; return typeof v === "function" ? v.bind(target) : v; },
    })), options);
  }
  w.eval(read("content.js"));
  // Waits as long as the step is allowed to take (plus a margin) before giving up.
  const msg = (message) => new Promise((resolve) => { for (const l of listeners) l(message, {}, resolve); setTimeout(() => resolve(undefined), (message.timeout || 1000) + 3000); });
  return { w, d: w.document, sent, msg };
}

// ───────────── Background (service worker in Chrome, scripts in Firefox) ─────────────
function background({ firefox = false, tabs = {}, onTabMessage = () => ({ ok: true }), siteAccess = true } = {}) {
  const areas = { local: {}, session: {} };
  const area = (name) => ({
    get: async (k) => { const a = areas[name]; if (k == null) return JSON.parse(JSON.stringify(a)); const o = {}; for (const x of [].concat(k)) if (x in a) o[x] = JSON.parse(JSON.stringify(a[x])); return o; },
    set: async (o) => { Object.assign(areas[name], JSON.parse(JSON.stringify(o))); },
    remove: async (k) => { for (const x of [].concat(k)) delete areas[name][x]; },
  });
  const listeners = { message: [], updated: [], removed: [] };
  const log = [];
  let nextTab = 100;
  const chrome = {
    storage: { local: area("local"), session: area("session"), onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener: (f) => listeners.message.push(f) }, getPlatformInfo: async () => ({}), getURL: (p) => `ext://${p}` },
    permissions: { contains: async () => siteAccess },
    scripting: { executeScript: async () => [] },
    windows: { update: async () => {} },
    tabs: {
      query: async () => Object.values(tabs),
      get: async (id) => { if (!tabs[id]) throw new Error("No tab"); return { ...tabs[id] }; },
      create: async ({ url }) => { const t = { id: nextTab++, url, status: "complete", windowId: 1 }; tabs[t.id] = t; log.push(`create:${url}`); return { ...t }; },
      update: async (id, { url }) => { if (url) tabs[id].url = url; log.push(`update:${id}`); return { ...tabs[id] }; },
      sendMessage: async (id, message) => {
        if (message.type === "TT_PING") return { ok: true };
        if (message.type !== "TT_RUN_STATUS" && message.type !== "TT_SET_RECORDING") log.push(`${message.type}${message.step ? ":" + message.step.type : ""}@${id}`);
        return onTabMessage(message, id);
      },
      onUpdated: { addListener: (f) => listeners.updated.push(f) },
      onRemoved: { addListener: (f) => listeners.removed.push(f) },
    },
  };
  const context = { chrome, console, setTimeout, clearTimeout, URL, Date, Math, JSON, Promise, structuredClone };
  context.globalThis = context;
  vm.createContext(context);
  if (firefox) {
    // Firefox: manifest "scripts" loads lib.js then background.js; there is no importScripts.
    vm.runInContext(read("lib.js"), context);
    vm.runInContext(read("background.js"), context);
  } else {
    context.importScripts = (file) => { log.push(`importScripts:${file}`); vm.runInContext(read(file), context); };
    vm.runInContext(read("background.js"), context);
  }
  const send = (message, sender = {}) => new Promise((resolve) => listeners.message[0](message, sender, resolve));
  const runFinished = async () => { for (let i = 0; i < 100; i++) { const s = await send({ type: "TT_GET_STATE" }); if (!s.result.run) return; await wait(150); } };
  return { areas, tabs, log, listeners, send, runFinished };
}

// ───────────── Popup / manager pages ─────────────
async function extensionPage(file, store, { query = "", reply = () => ({}), siteAccess = true } = {}) {
  const html = read(file).replace(/<script src="[^"]+"><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `chrome-extension://test/${file}${query}` });
  const w = dom.window;
  const errors = [];
  const sent = [];
  w.addEventListener("error", (e) => errors.push(e.message));
  w.chrome = {
    storage: { local: { get: async () => JSON.parse(JSON.stringify(store)), set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }, remove: async (k) => { for (const x of [].concat(k)) delete store[x]; } }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async (m) => { sent.push(m); if (m.type === "TT_GET_STATE") return { ok: true, result: { recording: null, run: null } }; return reply(m); }, getURL: (p) => p },
    permissions: { request: async () => siteAccess },
    tabs: { query: async () => [{ id: 7 }], create: async () => ({}), update: async () => ({}) },
  };
  w.structuredClone = structuredClone;
  w.Element.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.alert = (m) => errors.push(`alert:${m}`);
  w.confirm = () => true;
  w.close = () => {};
  w.eval(read("lib.js"));
  w.eval(read(file === "popup.html" ? "popup.js" : "editor.js"));
  await wait(300);
  return { w, d: w.document, errors, sent, store };
}

module.exports = { read, wait, ok, section, failed, contentPage, background, extensionPage };
