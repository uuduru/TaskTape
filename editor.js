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

const TYPE_LABEL = { navigate: "Page", click: "Click", type: "Type", select: "Choose", check: "Tick", key: "Key", submit: "Submit", upload: "Upload", wait: "Wait", waitFor: "Wait for" };

const params = new URLSearchParams(location.search);
let automations = [];
let runsById = {};
let currentId = params.get("id");
let current = null; // working copy of the selected automation
let justRecorded = params.get("new") === "1";
let runState = null;
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
  const response = await chrome.runtime.sendMessage({ type: "TT_GET_STATE" }).catch(() => null);
  runState = response?.ok ? response.result.run : null;
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
async function askForValues(automation, names) {
  const saved = await TT.getSavedVars(automation.id);
  const fields = $("#varsFields");
  fields.textContent = "";
  for (const name of names) {
    fields.append(h("label", { class: "field" }, name,
      h("input", { "data-var": name, type: TT.isSecretName(name) ? "password" : "text", value: saved[name] ?? "", autocomplete: "off" })));
  }
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

async function runCurrent() {
  if (!current) return;
  await saveNow();
  const names = TT.variablesOf(current);
  let variables = {};
  if (names.length) {
    variables = await askForValues(current, names);
    if (!variables) return;
    await TT.saveVars(current.id, variables);
  }
  // The manager tab itself can't be the target, so runs started here always open a new tab.
  const response = await chrome.runtime.sendMessage({ type: "TT_RUN", id: current.id, variables, where: "newTab" });
  if (!response?.ok) alert(response?.error || "Could not start the run.");
}

async function stopRun() {
  const response = await chrome.runtime.sendMessage({ type: "TT_STOP_RUN" });
  if (!response?.ok) alert(response?.error || "Could not stop the run.");
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
      return h("div", { class: "value" }, textInput(step.value, "Text to type, or {{Name}} to ask each run", (v) => { step.value = v; }));
    case "select":
      return h("div", { class: "value" }, textInput(step.optionText || step.value, "Option to choose", (v) => { step.value = v; step.optionText = v; }));
    case "check":
      return h("div", { class: "value" }, selectInput([["true", "Tick"], ["false", "Untick"]], step.value === "false" ? "false" : "true", (v) => { step.value = v; }));
    case "key":
      return h("div", { class: "value" }, selectInput([["Enter", "Enter"], ["Escape", "Escape"], ["Tab", "Tab"]], step.value || "Enter", (v) => { step.value = v; }));
    case "upload":
      return h("div", { class: "value" },
        h("div", { class: "hint", style: "margin: 0;" }, "The run pauses here and asks you for the file."),
        step.value ? h("div", { class: "inline", title: "File used when recording (the file itself is not stored)" }, `Recorded with: ${step.value}`) : null);
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
  const row = h("div", { class: `step${step.enabled === false ? " off" : ""}${isFailed ? " failed" : ""}` },
    toggle,
    h("div", { class: "num" }, index + 1),
    h("span", { class: `type t-${step.type}` }, TYPE_LABEL[step.type] || step.type),
    h("div", { class: "desc" },
      h("div", { class: "d", title: TT.describe(step) }, TT.describe(step)),
      where ? h("div", { class: "s", title: where }, where) : null,
      isFailed ? h("div", { class: "err" }, `Last run stopped here: ${failed.error}`) : null),
    valueEditor(step),
    h("div", { class: "ops" },
      hasTarget ? h("button", { class: "btn ghost small", title: "Advanced: how the element is found", onclick: () => { openAdvanced.has(step.id) ? openAdvanced.delete(step.id) : openAdvanced.add(step.id); renderMain(); } }, "⚙") : null,
      h("button", { class: "btn ghost small", title: "Move up", disabled: index === 0, onclick: () => moveStep(index, -1) }, "↑"),
      h("button", { class: "btn ghost small", title: "Move down", disabled: index === current.steps.length - 1, onclick: () => moveStep(index, 1) }, "↓"),
      h("button", { class: "btn ghost small", title: "Duplicate", onclick: () => { current.steps.splice(index + 1, 0, { ...structuredClone(step), id: TT.uid() }); scheduleSave(true); } }, "⧉"),
      h("button", { class: "btn ghost small", title: "Delete this step", onclick: () => { current.steps.splice(index, 1); scheduleSave(true); } }, "✕")));
  if (hasTarget && openAdvanced.has(step.id)) row.append(advancedPanel(step));
  return row;
}

function addStep(step, openSettings = false) {
  const full = { id: TT.uid(), enabled: true, ...step };
  current.steps.push(full);
  if (openSettings) openAdvanced.add(full.id);
  scheduleSave(true);
}

// ───────────────────────────── Main panel ─────────────────────────────
function renderBanner() {
  const slot = $("#bannerSlot");
  if (!slot || !current) return;
  slot.textContent = "";
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
          ? ["Asked at each run: ", ...vars.flatMap((v, i) => [i ? ", " : "", h("code", {}, `{{${v}}}`)])]
          : ["Tip: replace a typed text with ", h("code", {}, "{{Customer name}}"), " and TaskTape will ask for it each time you run."])),
    h("div", { class: "section-head" }, h("h2", {}, `Steps (${current.steps.length})`)),
    h("div", { class: "steps" },
      current.steps.length ? current.steps.map((step, i) => stepRow(step, i, lastFailed)) : h("div", { class: "step", style: "display: block; color: var(--muted);" }, "No steps. Add some below, or record again."),
      h("div", { class: "add-bar" },
        h("button", { class: "btn small", onclick: () => addStep({ type: "wait", ms: 2000 }) }, "+ Wait"),
        h("button", { class: "btn small", onclick: () => addStep({ type: "navigate", url: "https://", auto: false }) }, "+ Open a page"),
        h("button", { class: "btn small", onclick: () => addStep({ type: "key", value: "Enter" }) }, "+ Press a key"),
        h("button", { class: "btn small", onclick: () => addStep({ type: "waitFor", target: { selectors: [], text: "", tag: "", label: "element" } }, true) }, "+ Wait for an element"))),
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
