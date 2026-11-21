const $ = (selector) => document.querySelector(selector);

// Tiny DOM builder: always uses textContent, never innerHTML, so recorded page text can't inject markup.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  return el;
}

const TYPE_LABEL = { navigate: "Page", click: "Click", type: "Type", select: "Choose", check: "Tick", key: "Key", submit: "Submit", upload: "Upload", scroll: "Scroll", wait: "Wait", waitFor: "Wait for" };

const params = new URLSearchParams(location.search);
let automations = [];
let runsById = {};
let currentId = params.get("id");
let current = null; // working copy of the selected automation
let justRecorded = params.get("new") === "1";
let runState = null;
let backgroundProblem = ""; // shown as a banner when the background worker doesn't answer
let filter = "";
let saveTimer = null;
const ourSaves = new Set(); // updatedAt stamps written by this page (so we ignore our own storage events)
const openAdvanced = new Set();

// ───────────────────────────── Data ─────────────────────────────
async function reloadData() {
  const all = await chrome.storage.local.get(null);
  automations = Object.entries(all)
    .filter(([key]) => key.startsWith(TT.AUTO))
    .map(([, value]) => value)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  runsById = {};
  for (const [key, value] of Object.entries(all)) if (key.startsWith(TT.RUNS)) runsById[key.slice(TT.RUNS.length)] = value;
  const response = await TT.ask({ type: "TT_GET_STATE" });
  runState = response.ok ? response.result.run : null;
  backgroundProblem = response.ok ? "" : response.error;
}

function setSaveState(text) {
  const el = $("#saveState");
  if (el) el.textContent = text;
}

function scheduleSave(structural = false) {
  setSaveState("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
  if (structural) renderMain();
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const target = current; // the user may switch to another automation while this save is in flight
  if (!target) return;
  const copy = structuredClone(target);
  const stamp = Date.now();
  ourSaves.add(stamp); // registered before writing: the storage event can arrive before the write resolves
  await TT.saveAutomation(copy, stamp);
  target.updatedAt = stamp;
  const index = automations.findIndex((a) => a.id === copy.id);
  if (index >= 0) automations[index] = copy; else automations.unshift(copy);
  renderList();
  if (target === current) setSaveState("All changes saved");
}

function select(id) {
  if (current && saveTimer) saveNow();
  currentId = id;
  justRecorded = false;
  openAdvanced.clear();
  history.replaceState(null, "", id ? `?id=${encodeURIComponent(id)}` : location.pathname);
  const found = automations.find((a) => a.id === id);
  current = found ? structuredClone(found) : null;
  renderList();
  renderMain();
}

function download(filename, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (text) => (text || "automation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "automation";

// ───────────────────────────── Run ─────────────────────────────
async function askForValues(automation) {
  const saved = await TT.getSavedVars(automation.id);
  const fields = $("#varsFields");
  fields.textContent = "";
  for (const prompt of TT.promptsOf(automation)) {
    // Last value used wins; otherwise the value from the recording is suggested.
    const value = prompt.secret ? "" : (saved[prompt.name] ?? prompt.defaultValue);
    fields.append(h("label", { class: "field" }, prompt.name,
      h("input", { "data-var": prompt.name, type: prompt.secret ? "password" : "text", value, autocomplete: "off" })));
  }
  setTimeout(() => fields.querySelector("input")?.select(), 0);
  const dialog = $("#varsDialog");
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "run") return resolve(null);
      const values = {};
      for (const input of fields.querySelectorAll("input")) values[input.dataset.var] = input.value;
      resolve(values);
    }, { once: true });
  });
}

const NO_ACCESS = "TaskTape needs access to websites to work. Please allow it when your browser asks.";

async function runCurrent() {
  if (!current) return;
  const access = TT.ensureSiteAccess(); // first, while the click still counts as a user action
  await saveNow();
  if (!(await access)) return alert(NO_ACCESS);
  const names = TT.variablesOf(current);
  let variables = {};
  if (names.length) {
    variables = await askForValues(current);
    if (!variables) return;
    await TT.saveVars(current.id, variables);
  }
  // The manager tab itself can't be the target, so runs started here always open a new tab.
  const response = await TT.ask({ type: "TT_RUN", id: current.id, variables, where: "newTab" });
  if (!response.ok) alert(response.error || "Could not start the run.");
}

async function stopRun() {
  const response = await TT.ask({ type: "TT_STOP_RUN" });
  if (!response.ok) alert(response.error || "Could not stop the run.");
}

// ───────────────────────────── Sidebar ─────────────────────────────
function renderList() {
  const list = $("#autoList");
  list.textContent = "";
  const shown = automations.filter((a) => !filter || a.name.toLowerCase().includes(filter));
  for (const automation of shown) {
    const last = (runsById[automation.id] || [])[0];
    const steps = (automation.steps || []).filter((s) => s.enabled !== false).length;
    list.append(h("li", { class: automation.id === currentId ? "active" : "", onclick: () => select(automation.id) },
      h("span", { class: "n", title: automation.name }, automation.id === currentId && current ? current.name : automation.name),
      h("span", { class: "m" }, `${steps} step${steps === 1 ? "" : "s"}`,
        last ? h("span", { class: `badge ${last.status}` }, `${last.status === "success" ? "✓" : last.status === "failed" ? "✗" : "■"} ${TT.timeAgo(last.at)}`) : null)));
  }
  if (!shown.length) list.append(h("li", { class: "m", style: "cursor: default;" }, automations.length ? "No match." : "No automations yet."));
}

// ───────────────────────────── Step editing ─────────────────────────────
function textInput(value, placeholder, onChange) {
  const input = h("input", { value: value ?? "", placeholder });
  input.addEventListener("input", () => { onChange(input.value); scheduleSave(); });
  return input;
}

function selectInput(options, value, onChange) {
  const select = h("select", {}, options.map(([v, label]) => h("option", { value: v }, label)));
  select.value = value;
  select.addEventListener("change", () => { onChange(select.value); scheduleSave(true); });
  return select;
}

// Switch a "type" / "select" step between the value recorded and a question asked before each run.
function setAsk(step, on) {
  const asking = !!TT.askedName(step);
  if (on && !asking) {
    step.recordedValue = step.type === "select" ? (step.optionText || step.value || "") : (step.value ?? "");
    step.value = `{{${TT.toVarName(step.target?.label)}}}`;
    if (step.type === "select") step.optionText = undefined; // the answer is matched by option text or value
  } else if (!on && asking) {
    const value = step.recordedValue ?? "";
    step.value = value;
    if (step.type === "select") step.optionText = value;
  }
  scheduleSave(true);
}

function askableEditor(step) {
  const name = TT.askedName(step);
  const asking = !!name;
  // Passwords are never stored, so there is no recorded value to fall back on.
  const secret = !!step.secret || (asking && step.recordedValue == null && TT.isSecretName(name));
  const mode = h("div", { class: "mode", role: "group", "aria-label": "Value used when running" },
    h("button", {
      type: "button", class: `seg${asking ? "" : " on"}`, disabled: secret,
      title: secret ? "Passwords are never stored, so they are always asked." : "Always use the value recorded",
      onclick: () => setAsk(step, false),
    }, "Recorded value"),
    h("button", { type: "button", class: `seg${asking ? " on" : ""}`, title: "Ask for this value before each run", onclick: () => setAsk(step, true) }, "Ask each run"));

  if (!asking) {
    const isSelect = step.type === "select";
    if (isSelect && step.options?.length) {
      // The choices of the list are known (recorded or picked): offer them in a drop-down.
      const known = step.options.some((o) => o.value === step.value || o.text === step.optionText);
      const list = h("select", {},
        known ? null : h("option", { value: "" }, step.optionText || step.value ? `${step.optionText || step.value} (not in the list)` : "— choose —"),
        step.options.map((o, i) => h("option", { value: String(i) }, o.text || o.value || "(empty)")));
      const selected = step.options.findIndex((o) => o.value === step.value && (!step.optionText || o.text === step.optionText));
      list.value = known ? String(selected >= 0 ? selected : step.options.findIndex((o) => o.text === step.optionText)) : "";
      list.addEventListener("change", () => {
        const option = step.options[Number(list.value)];
        if (!option) return;
        step.value = option.value;
        step.optionText = option.text;
        scheduleSave();
      });
      return h("div", { class: "value" }, mode, list);
    }
    return h("div", { class: "value" }, mode,
      textInput(isSelect ? (step.optionText || step.value) : step.value, isSelect ? "Option to choose" : "Text to type",
        (v) => { step.value = v; if (isSelect) step.optionText = v; }));
  }

  const question = textInput(name, "Question shown before each run", (v) => { step.value = `{{${TT.toVarName(v || step.target?.label)}}}`; });
  question.title = "Steps with the same question share one answer";
  question.addEventListener("change", () => renderMain()); // refresh the list of questions
  return h("div", { class: "value" }, mode,
    h("label", { class: "inline" }, h("span", { class: "lbl" }, "Question:"), question),
    secret
      ? h("div", { class: "inline" }, "Never stored · asked at each run")
      : h("label", { class: "inline", title: "Pre-filled in the run form. Leave empty for no suggestion." }, h("span", { class: "lbl" }, "Suggested:"),
          textInput(step.recordedValue, "optional", (v) => { step.recordedValue = v; })));
}

function valueEditor(step) {
  switch (step.type) {
    case "navigate": {
      const auto = h("input", { type: "checkbox" });
      auto.checked = !!step.auto;
      auto.addEventListener("change", () => { step.auto = auto.checked; scheduleSave(true); });
      return h("div", { class: "value" },
        textInput(step.url, "https://…", (v) => { step.url = v; }),
        h("label", { class: "inline", title: "Ticked: the page changes by itself after the previous step, TaskTape just waits for it. Unticked: TaskTape opens this address." }, auto, "Happens by itself"));
    }
    case "type":
    case "select":
      return askableEditor(step);
    case "check":
      return h("div", { class: "value" }, selectInput([["true", "Tick"], ["false", "Untick"]], step.value === "false" ? "false" : "true", (v) => { step.value = v; }));
    case "key":
      return h("div", { class: "value" }, selectInput([["Enter", "Enter"], ["Escape", "Escape"], ["Tab", "Tab"]], step.value || "Enter", (v) => { step.value = v; }));
    case "upload":
      return h("div", { class: "value" },
        h("div", { class: "hint", style: "margin: 0;" }, "The run pauses here and asks you for the file."),
        step.value ? h("div", { class: "inline", title: "File used when recording (the file itself is not stored)" }, `Recorded with: ${step.value}`) : null);
    case "scroll": {
      const mode = selectInput([
        ["bottom", "To the bottom (loads more)"],
        ["top", "To the top"],
        ["by", "By an amount"],
        ["until", "Until an element appears"],
      ], step.mode || "bottom", (v) => {
        step.mode = v;
        // "Until an element appears" needs the element: go and pick it right away.
        if (v === "until" && !TT.hasElement(step)) pickFor(step.id);
      });
      if (step.mode !== "by") return h("div", { class: "value" }, mode);
      const amount = h("input", { type: "number", step: "100", value: String(step.amount || 600) });
      amount.addEventListener("input", () => { step.amount = Number(amount.value) || 600; scheduleSave(); });
      return h("div", { class: "value" }, mode, h("label", { class: "inline", title: "Use a negative number to scroll up" }, amount, "pixels (− = up)"));
    }
    case "wait": {
      const input = h("input", { type: "number", min: "0.1", step: "0.5", value: String((step.ms || 1000) / 1000) });
      input.addEventListener("input", () => { step.ms = Math.max(100, Math.round(Number(input.value) * 1000) || 1000); scheduleSave(); });
      return h("div", { class: "value" }, h("label", { class: "inline", style: "margin: 0;" }, input, "seconds"));
    }
    default:
      return h("div", { class: "value" });
  }
}

function advancedPanel(step) {
  step.target = step.target || { selectors: [], text: "", tag: "", label: "" };
  const selectors = h("textarea", { placeholder: "One CSS selector per line, most reliable first" });
  selectors.value = (step.target.selectors || []).join("\n");
  selectors.addEventListener("input", () => { step.target.selectors = selectors.value.split("\n").map((s) => s.trim()).filter(Boolean); scheduleSave(); });
  const text = textInput(step.target.text, "Visible text (fallback)", (v) => { step.target.text = v; });
  const label = textInput(step.target.label, "Name shown in this list", (v) => { step.target.label = v; });
  const timeout = h("input", { type: "number", min: "1", placeholder: "default", value: step.timeout ? String(step.timeout) : "" });
  timeout.addEventListener("input", () => { step.timeout = Number(timeout.value) || undefined; scheduleSave(); });
  return h("div", { class: "advanced" },
    h("label", { class: "field" }, "How to find the element", selectors),
    h("div", { style: "display: flex; flex-direction: column; gap: 8px;" },
      h("label", { class: "field" }, "Name", label),
      h("label", { class: "field" }, "Visible text", text)),
    h("label", { class: "field" }, "Max wait (s)", timeout));
}

function moveStep(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= current.steps.length) return;
  const [step] = current.steps.splice(index, 1);
  current.steps.splice(target, 0, step);
  scheduleSave(true);
}

function stepRow(step, index, failed) {
  const isFailed = failed && failed.failedStepId === step.id;
  const toggle = h("input", { type: "checkbox", title: "Include this step when running" });
  toggle.checked = step.enabled !== false;
  toggle.addEventListener("change", () => { step.enabled = toggle.checked; scheduleSave(true); });
  const where = step.type === "navigate" ? "" : step.target?.selectors?.[0] || "";
  const hasTarget = !["navigate", "wait"].includes(step.type);
  const canPick = TT.needsElement(step) || step.type === "key";
  const missing = TT.needsElement(step) && !TT.hasElement(step);
  const picking = pickingStepId === step.id;
  const site = TT.shortUrl(urlForStep(index)).split("/")[0];
  const pickButton = (label, cls = "btn ghost small") => h("button", {
    class: cls, disabled: !!pickingStepId || !!runState, onclick: () => pickFor(step.id),
    title: `TaskTape switches to ${site || "the website"}, you click the element there, then you come back here automatically`,
  }, label);
  const hidden = (text) => h("span", { class: "btn ghost small", style: "visibility: hidden;", "aria-hidden": "true" }, text); // keeps the buttons aligned
  const row = h("div", { "data-step": step.id, class: `step${step.enabled === false ? " off" : ""}${isFailed ? " failed" : ""}${missing ? " missing" : ""}${picking ? " picking" : ""}` },
    toggle,
    h("div", { class: "num" }, index + 1),
    h("span", { class: `type t-${step.type}` }, TYPE_LABEL[step.type] || step.type),
    h("div", { class: "desc" },
      h("div", { class: "d", title: TT.describe(step) }, TT.describe(step)),
      picking
        ? h("div", { class: "warn" }, "🎯 Waiting for you to click the element on the website…")
        : missing
          ? h("div", { class: "warn" },
              pickButton(site ? `🎯 Choose it on ${site}` : "🎯 Choose it on the website", "btn primary small"),
              h("span", { class: "how" }, "TaskTape opens the website, you click the element, then you come back here."))
          : where ? h("div", { class: "s", title: where }, where) : null,
      isFailed ? h("div", { class: "err" }, `Last run stopped here: ${failed.error}`) : null),
    valueEditor(step),
    h("div", { class: "ops" },
      canPick ? pickButton("🎯") : hidden("🎯"),
      hasTarget
        ? h("button", { class: "btn ghost small", title: "Advanced: how the element is found", onclick: () => { openAdvanced.has(step.id) ? openAdvanced.delete(step.id) : openAdvanced.add(step.id); renderMain(); } }, "⚙")
        : hidden("⚙"),
      h("button", { class: "btn ghost small", title: "Move up", disabled: index === 0, onclick: () => moveStep(index, -1) }, "↑"),
      h("button", { class: "btn ghost small", title: "Move down", disabled: index === current.steps.length - 1, onclick: () => moveStep(index, 1) }, "↓"),
      h("button", { class: "btn ghost small", title: "Duplicate", onclick: () => { current.steps.splice(index + 1, 0, { ...structuredClone(step), id: TT.uid() }); scheduleSave(true); } }, "⧉"),
      h("button", { class: "btn ghost small", title: "Delete this step", onclick: () => { current.steps.splice(index, 1); scheduleSave(true); } }, "✕")));
  if (hasTarget && openAdvanced.has(step.id)) row.append(advancedPanel(step));
  return row;
}

// ───────────────────────────── Adding steps & picking elements ─────────────────────────────
const EMPTY_TARGET = () => ({ selectors: [], text: "", tag: "", label: "" });
const NEW_STEPS = {
  click: () => ({ type: "click", target: EMPTY_TARGET() }),
  type: () => ({ type: "type", target: EMPTY_TARGET(), value: "" }),
  select: () => ({ type: "select", target: EMPTY_TARGET(), value: "" }),
  check: () => ({ type: "check", target: EMPTY_TARGET(), value: "true" }),
  upload: () => ({ type: "upload", target: EMPTY_TARGET(), value: "" }),
  submit: () => ({ type: "submit", target: EMPTY_TARGET() }),
  waitFor: () => ({ type: "waitFor", target: EMPTY_TARGET() }),
  navigate: () => ({ type: "navigate", url: "https://", auto: false }),
  scroll: () => ({ type: "scroll", mode: "bottom", timeout: 30 }),
  key: () => ({ type: "key", value: "Enter" }),
  wait: () => ({ type: "wait", ms: 2000 }),
};
const ELEMENT_BUTTONS = [["click", "Click"], ["type", "Type text"], ["select", "Choose an option"], ["check", "Tick a box"], ["upload", "Upload a file"], ["submit", "Submit a form"], ["waitFor", "Wait for an element"]];
const OTHER_BUTTONS = [["navigate", "Open a page"], ["scroll", "Scroll"], ["key", "Press a key"], ["wait", "Wait"]];
const PICK_HINT = {
  click: "the button, link or element to click",
  type: "the text field to type in",
  select: "the drop-down list",
  check: "the checkbox or radio button",
  upload: "the file field (or its Upload button)",
  submit: "any field of the form to submit",
  waitFor: "the element to wait for",
  scroll: "the element to scroll to (it may be further down the page)",
};

let insertAfter = "end"; // "end" or the id of the step after which new steps go
let pickingStepId = null;

function addStep(kind) {
  const step = { id: TT.uid(), enabled: true, ...NEW_STEPS[kind]() };
  const afterIndex = insertAfter === "end" ? -1 : current.steps.findIndex((s) => s.id === insertAfter);
  if (afterIndex >= 0) {
    current.steps.splice(afterIndex + 1, 0, step);
    insertAfter = step.id; // the next added step goes right after this one
  } else {
    current.steps.push(step);
  }
  scheduleSave(true);
  if (TT.needsElement(step)) pickFor(step.id);
  else focusStep(step.id);
}

function focusStep(stepId) {
  setTimeout(() => {
    const row = document.querySelector(`[data-step="${stepId}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
    row?.querySelector(".value input:not([type=checkbox]), .value select")?.focus();
  }, 50);
}

// The page a step happens on: the last "page" step before it (or the first one).
function urlForStep(index) {
  for (let i = index - 1; i >= 0; i--) if (current.steps[i].type === "navigate" && current.steps[i].url) return current.steps[i].url;
  return current.steps.find((s) => s.type === "navigate")?.url || "";
}

async function pickFor(stepId) {
  const access = TT.ensureSiteAccess(); // first, while the click still counts as a user action
  await saveNow();
  if (!(await access)) return alert(NO_ACCESS);
  const index = current.steps.findIndex((s) => s.id === stepId);
  if (index < 0) return;
  const kind = current.steps[index].type;
  pickingStepId = stepId;
  renderMain(); // shows the banner, marks the row and disables the other buttons while waiting
  const response = await TT.ask({ type: "TT_PICK", kind, hint: PICK_HINT[kind], url: urlForStep(index) });
  pickingStepId = null;
  const step = current?.steps.find((s) => s.id === stepId);
  if (!response.ok) alert(response.error || "Could not pick an element.");
  else if (step && response.result?.picked) applyPick(step, response.result.picked);
  renderMain();
  if (step) focusStep(stepId);
}

function applyPick(step, { target, info }) {
  step.target = target;
  if (step.type === "type") {
    if (info.isPassword) {
      // Never keep a password: it is asked at each run.
      step.secret = true;
      const name = TT.toVarName(target.label);
      step.value = `{{${/pass/i.test(name) ? name : `${name} password`}}}`;
    } else if (!step.value && info.currentValue) {
      step.value = info.currentValue;
    }
  }
  if (step.type === "select") {
    step.options = info.options;
    if (!step.value && info.currentText) { step.value = info.currentValue; step.optionText = info.currentText; }
  }
  if (step.type === "check" && info.checked === true) step.value = "true";
  if (step.type === "upload") {
    step.multiple = info.multiple || undefined;
    step.accept = info.accept || undefined;
  }
  scheduleSave(true);
}

function addBar() {
  const position = h("select", { title: "Where new steps are added" },
    h("option", { value: "end" }, "at the end"),
    current.steps.map((s, i) => h("option", { value: s.id }, `after step ${i + 1} · ${TT.describe(s).slice(0, 48)}`)));
  position.value = current.steps.some((s) => s.id === insertAfter) ? insertAfter : "end";
  position.addEventListener("change", () => { insertAfter = position.value; });
  const button = ([kind, label]) => h("button", { class: "btn small", onclick: () => addStep(kind), disabled: !!pickingStepId }, `+ ${label}`);
  return h("div", { class: "add-bar" },
    h("div", { class: "add-where" }, h("span", {}, "Add a step"), position),
    h("div", { class: "add-group" }, h("span", { class: "add-label", title: "You'll click the element on the website" }, "🎯 On the page:"), ELEMENT_BUTTONS.map(button)),
    h("div", { class: "add-group" }, h("span", { class: "add-label" }, "Other:"), OTHER_BUTTONS.map(button)));
}

// ───────────────────────────── Main panel ─────────────────────────────
function renderBanner() {
  const slot = $("#bannerSlot");
  if (!slot || !current) return;
  slot.textContent = "";
  if (backgroundProblem) {
    slot.append(h("div", { class: "banner warn" }, `⚠ ${backgroundProblem}`));
    return;
  }
  if (pickingStepId) {
    slot.append(h("div", { class: "banner info" },
      "🎯 TaskTape switched to the website tab: click the element for this step there (a purple bar at the top guides you). Press Esc on the website to cancel.",
      h("button", { class: "btn small", style: "margin-left: auto;", onclick: () => TT.ask({ type: "TT_PICK_CANCEL" }) }, "Cancel")));
    return;
  }
  if (runState && runState.automationId === current.id) {
    slot.append(h("div", { class: "banner info" },
      runState.waiting ? `⏸ Step ${runState.index}/${runState.total} is waiting for you: choose the file for “${runState.waiting}” in the page.` : `▶ Running · step ${runState.index}/${runState.total}`,
      runState.waiting && runState.tabId != null ? h("button", { class: "btn small primary", style: "margin-left: auto;", onclick: () => chrome.tabs.update(runState.tabId, { active: true }) }, "Show the page") : null,
      h("button", { class: "btn small", style: "margin-left: auto;", onclick: stopRun }, "■ Stop")));
  } else if (justRecorded) {
    slot.append(h("div", { class: "banner new" }, "✓ Recording saved. Check the steps below, give it a clear name, then press Run to try it."));
  }
}

function renderMain() {
  const main = $("#main");
  main.textContent = "";
  if (!current) {
    main.append(h("div", { class: "empty-state" },
      h("h1", {}, automations.length ? "Pick an automation on the left" : "Record your first automation"),
      automations.length ? null : h("ol", {},
        h("li", {}, "Open the website where your repetitive task starts."),
        h("li", {}, "Click the TaskTape icon in the toolbar and press ● Record."),
        h("li", {}, "Do the task once as usual."),
        h("li", {}, "Press ■ Stop in the red bar at the bottom of the page."),
        h("li", {}, "Next time, press ▶ Run and TaskTape does it for you."))));
    return;
  }
  const busy = !!runState;
  const runs = runsById[current.id] || [];
  const lastFailed = runs[0]?.status === "failed" ? runs[0] : null;
  const vars = TT.variablesOf(current);

  const nameInput = h("input", { id: "nameInput", value: current.name, maxlength: "80", "aria-label": "Automation name" });
  nameInput.addEventListener("input", () => { current.name = nameInput.value || "Untitled automation"; scheduleSave(); renderList(); });

  const description = h("textarea", { rows: "2", placeholder: "What does it do? When should it be used?" });
  description.value = current.description || "";
  description.addEventListener("input", () => { current.description = description.value; scheduleSave(); });

  current.settings = current.settings || {};
  const runIn = selectInput([["newTab", "A new tab"], ["currentTab", "The tab I'm on"]], current.settings.runIn || "newTab", (v) => { current.settings.runIn = v; });
  const speed = selectInput([["slow", "Slow (easy to watch)"], ["normal", "Normal"], ["fast", "Fast"]], current.settings.speed || "normal", (v) => { current.settings.speed = v; });
  const timeout = h("input", { type: "number", min: "1", max: "120", value: String(current.settings.stepTimeout || 10) });
  timeout.addEventListener("input", () => { current.settings.stepTimeout = Math.min(120, Math.max(1, Number(timeout.value) || 10)); scheduleSave(); });

  main.append(
    h("div", { id: "bannerSlot" }),
    h("div", { class: "top" },
      h("div", { class: "title" }, nameInput, h("p", { id: "saveState", class: "save-state" })),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", disabled: busy, onclick: runCurrent }, "▶ Run"),
        h("button", { class: "btn", onclick: duplicateCurrent }, "Duplicate"),
        h("button", { class: "btn", onclick: () => download(`${slug(current.name)}.tasktape.json`, TT.exportData([current])) }, "Export"),
        h("button", { class: "btn danger", onclick: deleteCurrent }, "Delete"))),
    h("div", { class: "settings" },
      h("label", { class: "field" }, "Description", description),
      h("label", { class: "field" }, "Run in (from the popup)", runIn),
      h("label", { class: "field" }, "Speed", speed),
      h("label", { class: "field" }, "Max wait per step (s)", timeout),
      h("div", { class: "vars-note" },
        vars.length
          ? ["Asked before each run: ", ...vars.flatMap((v, i) => [i ? ", " : "", h("code", {}, v)]), ". Steps with the same question share one answer."]
          : ["Tip: on a Type or Choose step, pick ", h("b", {}, "Ask each run"), " to be asked for that value every time you run."])),
    h("div", { class: "section-head" }, h("h2", {}, `Steps (${current.steps.length})`)),
    h("div", { class: "steps" },
      current.steps.length ? current.steps.map((step, i) => stepRow(step, i, lastFailed)) : h("div", { class: "step", style: "display: block; color: var(--muted);" }, "No steps. Add some below, or record again."),
      addBar()),
    h("section", { class: "runs" },
      h("div", { class: "section-head" }, h("h2", {}, "Recent runs")),
      runs.length
        ? h("table", {},
            h("tr", {}, h("th", {}, "When"), h("th", {}, "Result"), h("th", {}, "Duration"), h("th", {}, "Details")),
            runs.slice(0, 10).map((run) => h("tr", {},
              h("td", {}, new Date(run.at).toLocaleString()),
              h("td", {}, h("span", { class: `badge ${run.status}` }, run.status === "success" ? "Success" : run.status === "failed" ? "Failed" : "Stopped")),
              h("td", {}, `${Math.round(run.durationMs / 100) / 10}s`),
              h("td", {}, run.status === "failed" ? `Step ${run.failedStepNumber}: ${run.error}` : ""))))
        : h("p", { class: "hint" }, "Not run yet.")),
  );
  renderBanner();
  setSaveState(saveTimer ? "Saving…" : "");
}

async function duplicateCurrent() {
  await saveNow();
  const copy = TT.newAutomation({
    name: `${current.name} (copy)`,
    description: current.description,
    settings: structuredClone(current.settings || {}),
    steps: current.steps.map((s) => ({ ...structuredClone(s), id: TT.uid() })),
  });
  await TT.saveAutomation(copy);
  ourSaves.add(copy.updatedAt);
  await reloadData();
  select(copy.id);
}

async function deleteCurrent() {
  if (!confirm(`Delete “${current.name}”? This cannot be undone.`)) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await TT.deleteAutomation(current.id);
  await reloadData();
  current = null;
  select(automations[0]?.id || null);
}

// ───────────────────────────── Sidebar tools ─────────────────────────────
$("#filter").addEventListener("input", (e) => { filter = e.target.value.trim().toLowerCase(); renderList(); });
$("#exportAllBtn").addEventListener("click", async () => {
  if (saveTimer) await saveNow();
  if (!automations.length) return alert("There is nothing to export yet.");
  download(`tasktape-export-${new Date().toISOString().slice(0, 10)}.json`, TT.exportData(automations));
});
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const imported = TT.parseImport(JSON.parse(await file.text()));
    if (!imported.length) return alert("No automation found in this file.");
    for (const automation of imported) {
      await TT.saveAutomation(automation);
      ourSaves.add(automation.updatedAt);
    }
    await reloadData();
    select(imported[0].id);
    alert(`Imported ${imported.length} automation${imported.length === 1 ? "" : "s"}.`);
  } catch {
    alert("This file is not a valid TaskTape export.");
  }
});

// ───────────────────────────── Live updates ─────────────────────────────
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "session" && changes.state) {
    const wasRunning = !!runState;
    runState = changes.state.newValue?.run ?? null;
    renderBanner();
    if (wasRunning !== !!runState) renderMain(); // enable / disable the Run button
    return;
  }
  if (area !== "local") return;
  let refreshMain = false;
  for (const [key, change] of Object.entries(changes)) {
    if (key === TT.AUTO + currentId) {
      const fresh = change.newValue;
      if (fresh && ourSaves.has(fresh.updatedAt)) continue; // our own save
      current = fresh ? structuredClone(fresh) : null;
      refreshMain = true;
    }
    if (key === TT.RUNS + currentId) refreshMain = true;
  }
  const keepCurrent = current;
  await reloadData();
  current = keepCurrent;
  renderList();
  if (refreshMain) renderMain();
});

window.addEventListener("beforeunload", () => { if (saveTimer) saveNow(); });

(async () => {
  await reloadData();
  if (!currentId || !automations.some((a) => a.id === currentId)) currentId = automations[0]?.id || null;
  const found = automations.find((a) => a.id === currentId);
  current = found ? structuredClone(found) : null;
  renderList();
  renderMain();
})();
