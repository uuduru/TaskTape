// content.js: recording, replay, upload panel and element picker, in a simulated page.
const { ok, section, wait, contentPage } = require("./helpers");

const FORM = `<!doctype html><body>
  <form id="f">
    <label for="email">Email</label><input id="email" name="email" type="email" value="old@x.test">
    <label for="pw">Password</label><input id="pw" name="pwd" type="password">
    <select id="country" name="country"><option value="">--</option><option value="fr">France</option><option value="ng">Nigeria</option></select>
    <label><input type="checkbox" id="agree" name="agree"> I agree</label>
    <label for="att">Attachment</label><input id="att" name="att" type="file" accept=".pdf">
    <button type="button" id="up">Upload…</button>
    <button id="send"><span>Sign in</span></button>
  </form>
  <a id="lnk" href="#">Help</a>
</body>`;

module.exports = async function contentTests() {
  section("Recording (content.js)");
  const rec = contentPage(FORM, { trustEvents: true });
  rec.d.getElementById("f").addEventListener("submit", (e) => e.preventDefault());
  await rec.msg({ type: "TT_SET_RECORDING", on: true, count: 1 });
  ok(!!rec.d.querySelector("[data-tasktape]"), "red recording bar shown");
  const type = (el, v) => { el.value = v; el.dispatchEvent(new rec.w.Event("input", { bubbles: true })); };
  type(rec.d.getElementById("email"), "ugo@example.com");
  type(rec.d.getElementById("pw"), "s3cret!");
  const select = rec.d.getElementById("country");
  select.value = "ng";
  select.dispatchEvent(new rec.w.Event("change", { bubbles: true }));
  rec.d.getElementById("agree").click();
  const att = rec.d.getElementById("att");
  att.files = [new rec.w.File(["%PDF"], "invoice.pdf")];
  att.dispatchEvent(new rec.w.Event("change", { bubbles: true }));
  rec.d.querySelector("#send span").click();
  const steps = rec.sent.filter((m) => m.type === "TT_STEP").map((m) => m.step);
  ok(steps.map((s) => s.type).join(",") === "type,type,select,check,upload,click", `step order: ${steps.map((s) => s.type).join(",")}`);
  ok(steps[0].target.selectors[0] === "#email" && steps[0].value === "ugo@example.com", "typing recorded with a stable selector");
  ok(steps[1].value === "{{Password}}" && steps[1].secret && !JSON.stringify(steps).includes("s3cret"), "password never recorded");
  ok(steps[2].optionText === "Nigeria" && steps[2].options.length === 3, "drop-down: value, text and choices");
  ok(steps[4].value === "invoice.pdf" && !JSON.stringify(steps).includes("%PDF"), "upload: file name only");
  ok(steps[5].target.label === "Sign in" && steps[5].target.tag === "button", "click recorded on the button, not the inner text");

  section("Replay (content.js)");
  const run = contentPage(FORM);
  let submits = 0;
  run.d.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submits++; });
  for (const step of steps.filter((s) => s.type !== "upload")) {
    const filled = step.value === "{{Password}}" ? { ...step, value: "s3cret!" } : step;
    const r = await run.msg({ type: "TT_EXECUTE", step: filled, timeout: 1000 });
    ok(r && r.ok, `replay ${step.type}${r && !r.ok ? " → " + r.error : ""}`);
  }
  ok(run.d.getElementById("email").value === "ugo@example.com" && run.d.getElementById("pw").value === "s3cret!", "fields filled");
  ok(run.d.getElementById("country").value === "ng" && run.d.getElementById("agree").checked, "choice and checkbox set");
  ok(submits === 1, "form submitted exactly once");
  const missing = await run.msg({ type: "TT_EXECUTE", step: { type: "click", target: { selectors: ["#nope"], text: "Nope", label: "Nope" } }, timeout: 300 });
  ok(missing && !missing.ok && missing.retry, "missing element → retryable error");

  section("Upload panel (content.js)");
  let changes = 0;
  run.d.getElementById("att").addEventListener("change", () => changes++);
  ok((await run.msg({ type: "TT_UPLOAD_PROMPT", step: { ...steps[4], id: "u1" }, timeout: 500, position: "5/6" })).ok, "panel shown");
  const panel = [...run.d.querySelectorAll("[data-tasktape]")].find((h) => h.shadowRoot.querySelector(".panel")).shadowRoot;
  ok(panel.querySelector("h3").textContent === "Choose the file for “Attachment”", "asks for the right field");
  const picker = panel.querySelector("input[type=file]");
  picker.files = [new run.w.File(["x"], "april.pdf")];
  picker.dispatchEvent(new run.w.Event("change"));
  ok(run.d.getElementById("att").files[0]?.name === "april.pdf" && changes === 1, "chosen file attached to the page");
  ok((await run.msg({ type: "TT_UPLOAD_STATUS", stepId: "u1" })).status === "done", "status done → the run can continue");

  section("Scrolling (content.js)");
  // jsdom has no layout: simulate a page of 2,000 px that loads 1,000 px more (with new items) each time the bottom is reached, 3 times.
  const lazyPage = () => {
    const page = contentPage("<!doctype html><body><ul id='list'><li>Item 1</li></ul></body>");
    const root = page.d.documentElement;
    let height = 2000;
    let top = 0;
    let loads = 0;
    Object.defineProperty(root, "scrollHeight", { get: () => height, configurable: true });
    Object.defineProperty(root, "clientHeight", { get: () => 800, configurable: true });
    Object.defineProperty(root, "scrollTop", { get: () => top, set: (v) => { top = v; }, configurable: true });
    const moved = () => {
      top = Math.max(0, Math.min(top, height - 800));
      if (top >= height - 800 && loads < 3) {
        loads += 1;
        height += 1000;
        const li = page.d.createElement("li");
        li.textContent = `Loaded ${loads}`;
        if (loads === 3) li.id = "last-item";
        page.d.getElementById("list").append(li);
      }
    };
    root.scrollTo = ({ top: t }) => { top = t; moved(); };
    root.scrollBy = ({ top: t }) => { top += t; moved(); };
    return { ...page, pos: () => top, loads: () => loads };
  };
  const lazy = lazyPage();
  let sr = await lazy.msg({ type: "TT_EXECUTE", step: { type: "scroll", mode: "bottom" }, timeout: 8000 });
  ok(sr.ok && lazy.loads() === 3 && lazy.pos() === 4200, `to the bottom: kept scrolling while content loaded (${lazy.loads()} loads, at ${lazy.pos()} px)`);
  sr = await lazy.msg({ type: "TT_EXECUTE", step: { type: "scroll", mode: "top" }, timeout: 1000 });
  ok(sr.ok && lazy.pos() === 0, "to the top");
  sr = await lazy.msg({ type: "TT_EXECUTE", step: { type: "scroll", mode: "by", amount: 500 }, timeout: 1000 });
  ok(sr.ok && lazy.pos() === 500, "by an amount");
  const finder = lazyPage();
  sr = await finder.msg({ type: "TT_EXECUTE", step: { type: "scroll", mode: "until", target: { selectors: ["#last-item"], text: "Loaded 3", tag: "li", label: "Loaded 3" } }, timeout: 15000 });
  ok(sr.ok && finder.loads() === 3, "until an element appears: found an item that only loads after scrolling");
  const nothing = lazyPage();
  sr = await nothing.msg({ type: "TT_EXECUTE", step: { type: "scroll", mode: "until", target: { selectors: ["#never"], text: "", label: "Never" } }, timeout: 15000 });
  ok(!sr.ok && !sr.retry && /Reached the end of the page/.test(sr.error), "until: clear failure when the end is reached without finding it");

  section("Element picker (content.js)");
  const pick = contentPage(FORM);
  let pageClicks = 0;
  pick.d.getElementById("send").addEventListener("click", () => pageClicks++);
  const status = () => pick.msg({ type: "TT_PICK_STATUS" });
  await pick.msg({ type: "TT_PICK_START", kind: "click" });
  pick.d.getElementById("send").click();
  let s = await status();
  ok(s.status === "done" && s.result.target.selectors[0] === "#send" && pageClicks === 0, "click step: button picked, page did not react");
  await pick.msg({ type: "TT_PICK_START", kind: "type" });
  pick.d.querySelector("label[for=email]").click();
  s = await status();
  ok(s.status === "done" && s.result.target.selectors[0] === "#email" && s.result.info.currentValue === "old@x.test", "type step: label → field and its value");
  await pick.msg({ type: "TT_PICK_START", kind: "type" });
  pick.d.getElementById("lnk").click();
  ok((await status()).status === "picking", "type step: a link is refused, still picking");
  pick.d.dispatchEvent(new pick.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok((await status()).status === "cancelled", "Esc cancels");
  await pick.msg({ type: "TT_PICK_START", kind: "upload" });
  pick.d.getElementById("up").click();
  s = await status();
  ok(s.status === "done" && s.result.target.selectors[0] === "#att", "upload step: custom button → the real file field");
  await wait(10);
};
