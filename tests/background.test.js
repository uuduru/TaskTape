// background.js: recording sessions, runs, uploads, element picking — in Chrome mode and Firefox mode.
const { ok, section, wait, background } = require("./helpers");

const web = () => ({ 1: { id: 1, url: "https://x.test/login", status: "complete", windowId: 1 } });

async function recordAndRun(firefox) {
  const label = firefox ? "Firefox" : "Chrome";
  section(`Background · ${label}`);
  const bg = background({ firefox, tabs: web() });
  ok(firefox ? !bg.log.some((l) => l.startsWith("importScripts")) : bg.log.includes("importScripts:lib.js"),
    firefox ? "starts as a background script (no importScripts)" : "starts as a service worker (imports lib.js)");
  const page = { tab: { id: 1 }, frameId: 0 };
  ok((await bg.send({ type: "TT_START_RECORDING", tabId: 1, name: "Demo" })).ok, "recording started");
  const email = { selectors: ["#email"], label: "Email" };
  await bg.send({ type: "TT_STEP", step: { type: "type", target: email, value: "u" } }, page);
  await bg.send({ type: "TT_STEP", step: { type: "type", target: email, value: "ugo@x.test" } }, page);
  await bg.send({ type: "TT_STEP", step: { type: "type", target: { selectors: ["#pw"], label: "Password" }, value: "{{Password}}", secret: true } }, page);
  await bg.send({ type: "TT_STEP", step: { type: "click", target: { selectors: ["button"], label: "Sign in" } } }, page);
  bg.listeners.updated[0](1, { url: "https://x.test/redirect" });
  bg.listeners.updated[0](1, { url: "https://x.test/home" });
  await wait(50);
  const rec = (await bg.send({ type: "TT_GET_STATE" })).result.recording;
  ok(rec.steps.map((s) => s.type).join(",") === "navigate,type,type,click,navigate", "steps recorded, typing merged");
  ok(rec.steps[4].auto && rec.steps[4].url.endsWith("/home"), "redirects collapsed into one automatic page change");
  const saved = await bg.send({ type: "TT_STOP_RECORDING", save: true });
  ok(saved.ok && saved.result.saved, "recording saved");
  const id = saved.result.id;
  bg.areas.local[`auto:${id}`].settings.speed = "fast";

  let r = await bg.send({ type: "TT_RUN", id, variables: {} });
  ok(!r.ok && /missing/i.test(r.error), "run refused while a value is missing");
  r = await bg.send({ type: "TT_RUN", id, variables: { Password: "pw!" }, where: "newTab" });
  ok(r.ok, "run started");
  await bg.runFinished();
  const run = bg.areas.local[`runs:${id}`][0];
  ok(run.status === "success", `run succeeded (${run.status} ${run.error})`);
  ok(bg.log.filter((l) => l.startsWith("TT_EXECUTE")).join(",").includes("TT_EXECUTE:type") && !JSON.stringify(bg.areas).includes("pw!"), "steps executed, password never stored");
}

module.exports = async function backgroundTests() {
  await recordAndRun(false);
  await recordAndRun(true);

  section("Background · failures, upload pause, permissions");
  let behaviour = () => ({ ok: true });
  let uploadStatus = [];
  const bg = background({
    tabs: web(),
    onTabMessage: (m) => {
      if (m.type === "TT_EXECUTE") return behaviour(m.step);
      if (m.type === "TT_UPLOAD_STATUS") return { status: uploadStatus.length ? uploadStatus.shift() : "waiting" };
      return { ok: true };
    },
  });
  bg.areas.local["auto:a"] = { id: "a", name: "Invoice", settings: { speed: "fast", stepTimeout: 3 }, steps: [
    { id: "1", type: "navigate", url: "https://x.test/form", enabled: true },
    { id: "2", type: "upload", target: { selectors: ["#att"], label: "Attachment" }, value: "inv.pdf", enabled: true },
    { id: "3", type: "click", target: { selectors: ["button"], label: "Send" }, enabled: true } ] };
  uploadStatus = ["waiting", "none", "waiting", "done"];
  await bg.send({ type: "TT_RUN", id: "a", variables: {} });
  await wait(900);
  const paused = (await bg.send({ type: "TT_GET_STATE" })).result.run;
  ok(paused?.waiting === "Attachment" && !bg.log.some((l) => l.startsWith("TT_EXECUTE:click")), "run pauses on the upload step");
  await bg.runFinished();
  ok(bg.areas.local["runs:a"][0].status === "success" && bg.log.filter((l) => l.startsWith("TT_UPLOAD_PROMPT")).length === 2, "continues after the file is chosen (panel shown again after a reload)");

  behaviour = (s) => (s.type === "click" ? { ok: false, error: "Button disabled" } : { ok: true });
  uploadStatus = ["skipped"];
  await bg.send({ type: "TT_RUN", id: "a", variables: {} });
  await bg.runFinished();
  const failedRun = bg.areas.local["runs:a"][0];
  ok(failedRun.status === "failed" && failedRun.failedStepNumber === 3 && failedRun.error === "Button disabled", "failure recorded with its step");

  // Endless page: "scroll to the bottom" keeps asking for more rounds; at the end of its time the step still succeeds.
  bg.areas.local["auto:s"] = { id: "s", name: "Feed", settings: { speed: "fast" }, steps: [
    { id: "1", type: "navigate", url: "https://x.test/feed", enabled: true }, { id: "2", type: "scroll", mode: "bottom", timeout: 2, enabled: true },
    { id: "3", type: "scroll", mode: "until", timeout: 2, target: { selectors: ["#x"], label: "X" }, enabled: true } ] };
  behaviour = (s) => (s.type === "scroll" ? { ok: false, retry: true, error: s.mode === "until" ? "Scrolled for a while without finding “X”." : "The page keeps loading more content." } : { ok: true });
  await bg.send({ type: "TT_RUN", id: "s", variables: {} });
  await bg.runFinished();
  const scrollRun = bg.areas.local["runs:s"][0];
  ok(scrollRun.status === "failed" && scrollRun.failedStepNumber === 3 && /without finding “X”/.test(scrollRun.error), "endless page: “to the bottom” succeeds when time is up, “until” fails with its reason");

  bg.areas.local["auto:b"] = { id: "b", name: "B", settings: {}, steps: [
    { id: "1", type: "navigate", url: "https://x.test/", enabled: true }, { id: "2", type: "click", target: { selectors: [], text: "", label: "" }, enabled: true } ] };
  const r = await bg.send({ type: "TT_RUN", id: "b", variables: {} });
  ok(!r.ok && /Step 2 .*no element yet/.test(r.error), "run refused while a step has no element");

  const noAccess = background({ tabs: web(), siteAccess: false });
  const denied = await noAccess.send({ type: "TT_START_RECORDING", tabId: 1 });
  ok(!denied.ok && /needs permission/.test(denied.error), "no website access (Firefox) → clear message");
  const blocked = background({ tabs: { 1: { id: 1, url: "about:addons", status: "complete" } } });
  const refused = await blocked.send({ type: "TT_START_RECORDING", tabId: 1 });
  ok(!refused.ok && /addons\.mozilla\.org/.test(refused.error), "protected page → message mentions both add-on stores");

  section("Background · element picking");
  let pickStatus = [];
  const pk = background({
    tabs: { 1: { id: 1, url: "ext://editor.html", status: "complete", windowId: 1 }, 2: { id: 2, url: "https://shop.test/cart", status: "complete", windowId: 1, lastAccessed: 5 } },
    onTabMessage: (m) => (m.type === "TT_PICK_STATUS" ? (pickStatus.length ? pickStatus.shift() : { status: "picking" }) : { ok: true }),
  });
  const manager = { tab: { id: 1 }, frameId: 0 };
  pickStatus = [{ status: "picking" }, { status: "done", result: { target: { selectors: ["#buy"], label: "Buy" }, info: {} } }];
  const picked = await pk.send({ type: "TT_PICK", kind: "click", url: "https://shop.test/admin" }, manager);
  ok(picked.ok && picked.result.picked.target.label === "Buy", "element picked on the same website's tab");
  ok(pk.log.includes("TT_PICK_START@2") && pk.log.at(-1) === "update:1", "back to the manager afterwards");
  const unknown = await pk.send({ type: "TT_PICK", kind: "click", url: "" }, manager);
  ok(!unknown.ok && /Open the website/.test(unknown.error), "no website known → clear message");
};
