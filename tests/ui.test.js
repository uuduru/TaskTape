// popup.js and editor.js (the manager) in simulated extension pages.
const { ok, section, wait, extensionPage } = require("./helpers");

const automation = () => ({
  "auto:a1": { id: "a1", name: "Supplier invoice", createdAt: 1, updatedAt: 1, settings: {}, steps: [
    { id: "s1", type: "navigate", url: "https://shop.test/admin/new", enabled: true },
    { id: "s2", type: "type", target: { selectors: ["#num"], label: "Invoice number" }, value: "{{Invoice number}}", recordedValue: "INV-1", enabled: true },
    { id: "s3", type: "select", target: { selectors: ["#cur"], label: "Currency" }, value: "EUR", optionText: "Euro (EUR)", options: [{ value: "EUR", text: "Euro (EUR)" }, { value: "USD", text: "Dollar (USD)" }], enabled: true },
    { id: "s4", type: "click", target: { selectors: ["button"], label: "Go <b>x</b>" }, enabled: true } ] },
  "runs:a1": [{ at: Date.now() - 60000, durationMs: 3000, status: "failed", error: "Not found", failedStepId: "s4", failedStepNumber: 4 }],
});

module.exports = async function uiTests() {
  section("Popup");
  const p = await extensionPage("popup.html", automation(), { reply: () => ({ ok: true, result: {} }) });
  ok(!p.errors.length, `renders without errors ${p.errors.join(" | ")}`);
  ok(p.d.querySelector("#list .name")?.textContent === "Supplier invoice" && /1 value to fill/.test(p.d.querySelector("#list").textContent), "lists the automation and its question");
  p.d.querySelector("#list .btn.primary").click();
  await wait(150);
  const field = p.d.querySelector(".vars input");
  ok(field?.dataset.var === "Invoice number" && field.value === "INV-1", "run form pre-filled with the recorded value");
  p.d.querySelector(".vars .btn.primary").click();
  await wait(150);
  ok(p.sent.some((m) => m.type === "TT_RUN" && m.variables["Invoice number"] === "INV-1"), "run sent with the answers");

  const denied = await extensionPage("popup.html", automation(), { siteAccess: false });
  denied.d.querySelector("#record").click();
  await wait(150);
  ok(/needs access to websites/.test(denied.d.querySelector("#error").textContent) && !denied.sent.some((m) => m.type === "TT_START_RECORDING"), "website access refused (Firefox) → explained, nothing started");

  section("Manager");
  let pickReply = async () => ({ ok: true, result: { cancelled: true } });
  const e = await extensionPage("editor.html", automation(), { query: "?id=a1", reply: (m) => (m.type === "TT_PICK" ? pickReply(m) : { ok: true, result: {} }) });
  const d = e.d;
  ok(!e.errors.length, `renders without errors ${e.errors.join(" | ")}`);
  ok(d.querySelectorAll(".step").length === 4 && d.querySelector(".step.failed .err"), "steps listed, failed step highlighted");
  ok(d.body.innerHTML.includes("Go &lt;b&gt;x&lt;/b&gt;"), "page text is escaped, never injected as HTML");
  const choice = d.querySelector('[data-step="s3"] .value select');
  ok(choice && choice.options.length === 2, "known choices offered in a drop-down");
  const segs = [...d.querySelectorAll('[data-step="s3"] .seg')];
  segs[1].click();
  await wait(600);
  ok(e.store["auto:a1"].steps[2].value === "{{Currency}}" && e.store["auto:a1"].steps[2].recordedValue === "Euro (EUR)", "“Ask each run” keeps the recorded choice as suggestion");

  const add = (text) => [...d.querySelectorAll(".add-bar .btn")].find((b) => b.textContent === `+ ${text}`);
  ok(["Click", "Type text", "Choose an option", "Tick a box", "Upload a file", "Submit a form", "Wait for an element", "Open a page", "Scroll", "Press a key", "Wait"].every(add), "add bar offers every step type");
  pickReply = async () => ({ ok: true, result: { picked: { target: { selectors: ["#qty"], label: "Quantity" }, info: { currentValue: "3" } } } });
  add("Type text").click();
  await wait(900);
  const added = e.store["auto:a1"].steps.at(-1);
  ok(added.type === "type" && added.target.label === "Quantity" && added.value === "3", "new step gets the element clicked on the website");
  ok(e.sent.some((m) => m.type === "TT_PICK" && m.url === "https://shop.test/admin/new"), "picking happens on the step's website");

  add("Scroll").click();
  await wait(700);
  const scroll = e.store["auto:a1"].steps.at(-1);
  ok(scroll.type === "scroll" && scroll.mode === "bottom" && /Scroll to the bottom/.test(d.querySelector(`[data-step="${scroll.id}"] .d`).textContent), "Scroll step added (to the bottom by default)");
  pickReply = async () => ({ ok: true, result: { picked: { target: { selectors: ["#more"], label: "Show more" }, info: {} } } });
  const modeSelect = d.querySelector(`[data-step="${scroll.id}"] .value select`);
  modeSelect.value = "until";
  modeSelect.dispatchEvent(new e.w.Event("change"));
  await wait(900);
  const until = e.store["auto:a1"].steps.find((s) => s.id === scroll.id);
  ok(until.mode === "until" && until.target.label === "Show more", "“Until an element appears” asks to pick the element right away");
  ok(/until “Show more” appears/.test(d.querySelector(`[data-step="${scroll.id}"] .d`).textContent), "description names the element");

  pickReply = async () => undefined;
  d.querySelector('[data-step="s4"] .ops button[title^="TaskTape switches"]').click();
  await wait(800);
  ok(/reload it: open chrome:\/\/extensions/.test(e.errors.at(-1) || ""), "no answer from the background → advice to reload TaskTape");
};
