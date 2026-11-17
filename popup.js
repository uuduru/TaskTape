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

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "Something went wrong.");
  return response.result;
}

function showError(error) {
  const box = $("#error");
  box.textContent = error ? error.message || String(error) : "";
  box.classList.toggle("hidden", !error);
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

let openVarsFor = null; // automation id whose variable form is open
let filter = "";

async function runNow(automation, variables) {
  showError(null);
  try {
    if (Object.keys(variables).length) await TT.saveVars(automation.id, variables);
    await send("TT_RUN", { id: automation.id, variables, where: automation.settings?.runIn || "newTab", tabId: await activeTabId() });
    window.close();
  } catch (error) {
    showError(error);
  }
}

async function renderVarForm(automation, names) {
  const saved = await TT.getSavedVars(automation.id);
  const inputs = names.map((name) => h("input", {
    "data-var": name,
    type: TT.isSecretName(name) ? "password" : "text",
    placeholder: name,
    value: saved[name] ?? "",
    autocomplete: "off",
  }));
  const go = () => {
    const values = {};
    for (const input of inputs) values[input.dataset.var] = input.value;
    runNow(automation, values);
  };
  inputs.forEach((input) => input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); }));
  const box = h("div", { class: "vars" },
    h("div", { class: "hint", style: "margin: 0;" }, "Values for this run:"),
    inputs.map((input) => h("label", { class: "field" }, input.dataset.var, input)),
    h("div", { class: "row" },
      h("button", { class: "btn primary small", onclick: go }, "▶ Run now"),
      h("button", { class: "btn ghost small", onclick: () => { openVarsFor = null; render(); } }, "Cancel")),
  );
  setTimeout(() => inputs[0]?.focus(), 0);
  return box;
}

async function render() {
  let state;
  try {
    state = await send("TT_GET_STATE");
  } catch (error) {
    showError(error);
    return;
  }
  const all = await chrome.storage.local.get(null);
  const automations = Object.entries(all)
    .filter(([key]) => key.startsWith(TT.AUTO))
    .map(([, value]) => value)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  // Live box: recording or running
  const live = $("#live");
  live.textContent = "";
  live.className = "card live";
  if (state.recording) {
    live.append(
      h("strong", {}, `● Recording “${state.recording.name || "new automation"}” · ${state.recording.steps.length} step${state.recording.steps.length === 1 ? "" : "s"}`),
      h("div", { class: "row" },
        h("button", { class: "btn red", style: "flex: 1;", onclick: async () => { try { await send("TT_STOP_RECORDING", { save: true }); window.close(); } catch (e) { showError(e); } } }, "■ Stop & save"),
        h("button", { class: "btn", onclick: async () => { if (!confirm("Throw away this recording?")) return; try { await send("TT_STOP_RECORDING", { save: false }); render(); } catch (e) { showError(e); } } }, "Discard")),
    );
  } else if (state.run) {
    live.classList.add("run");
    const runTabId = state.run.tabId;
    live.append(
      h("strong", {}, state.run.waiting
        ? `⏸ “${state.run.name}” is waiting for you: choose the file for “${state.run.waiting}” in the page.`
        : `▶ Running “${state.run.name}” · step ${state.run.index}/${state.run.total}`),
      h("div", { class: "row" },
        state.run.waiting && runTabId != null ? h("button", { class: "btn primary", onclick: () => { chrome.tabs.update(runTabId, { active: true }); window.close(); } }, "Show the page") : null,
        h("button", { class: "btn", onclick: async () => { try { await send("TT_STOP_RUN"); } catch (e) { showError(e); } } }, "■ Stop")),
    );
  } else {
    live.classList.add("hidden");
  }
  $("#recordBox").classList.toggle("hidden", !!(state.recording || state.run));

  // List
  $("#count").textContent = automations.length ? String(automations.length) : "";
  $("#search").classList.toggle("hidden", automations.length < 6);
  const list = $("#list");
  list.textContent = "";
  const shown = automations.filter((a) => !filter || a.name.toLowerCase().includes(filter));
  if (!automations.length) {
    list.append(h("li", { class: "empty" }, "Nothing recorded yet. Open the website where your task starts and press Record."));
    return;
  }
  for (const automation of shown) {
    const lastRun = (all[TT.RUNS + automation.id] || [])[0];
    const steps = (automation.steps || []).filter((s) => s.enabled !== false).length;
    const vars = TT.variablesOf(automation);
    const busy = !!(state.recording || state.run);
    const item = h("li", {},
      h("div", { class: "item" },
        h("div", { class: "info" },
          h("div", { class: "name", title: automation.name }, automation.name),
          h("div", { class: "meta" },
            `${steps} step${steps === 1 ? "" : "s"}`,
            vars.length ? h("span", { class: "badge", title: vars.join(", ") }, `${vars.length} value${vars.length === 1 ? "" : "s"} to fill`) : null,
            lastRun ? h("span", { class: `badge ${lastRun.status}`, title: lastRun.error || "" }, `${lastRun.status === "success" ? "✓" : lastRun.status === "failed" ? "✗" : "■"} ${TT.timeAgo(lastRun.at)}`) : null)),
        h("button", {
          class: "btn primary small", disabled: busy, title: "Run this automation",
          onclick: () => { if (vars.length) { openVarsFor = openVarsFor === automation.id ? null : automation.id; render(); } else runNow(automation, {}); },
        }, "▶ Run"),
        h("button", { class: "btn small", title: "Edit the steps", onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${automation.id}`) }) }, "Edit")),
    );
    if (openVarsFor === automation.id && !busy) item.append(await renderVarForm(automation, vars));
    list.append(item);
  }
  if (!shown.length) list.append(h("li", { class: "empty" }, "No automation matches your search."));
}

$("#record").addEventListener("click", async () => {
  showError(null);
  try {
    await send("TT_START_RECORDING", { tabId: await activeTabId(), name: $("#name").value });
    window.close(); // give the page back to the user
  } catch (error) {
    showError(error);
  }
});
$("#name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#record").click(); });
$("#openManager").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("editor.html") }));
$("#search").addEventListener("input", (e) => { filter = e.target.value.trim().toLowerCase(); render(); });

let renderTimer = null;
chrome.storage.onChanged.addListener(() => {
  if (document.activeElement?.closest?.(".vars")) return; // don't wipe values being typed
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
});

render();
