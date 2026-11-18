// Shared helpers for the popup, the manager page and the background service worker.
// Everything is stored locally in chrome.storage.local:
//   auto:<id>  one automation (name, settings, steps)
//   runs:<id>  last 20 runs of that automation
//   vars:<id>  last values typed for its variables (never passwords)

const TT = (() => {
  const AUTO = "auto:";
  const RUNS = "runs:";
  const VARS = "vars:";
  const STEP_TYPES = ["navigate", "click", "type", "select", "check", "key", "submit", "upload", "wait", "waitFor"];
  // {{Customer name}} — letters, digits, spaces, dot, dash, underscore.
  const VAR_RE = /\{\{\s*([A-Za-z][\w .-]*?)\s*\}\}/g;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  async function listAutomations() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(AUTO))
      .map(([, value]) => value)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function getAutomation(id) {
    const result = await chrome.storage.local.get(AUTO + id);
    return result[AUTO + id] || null;
  }

  async function saveAutomation(automation, stamp = Date.now()) {
    automation.updatedAt = stamp;
    await chrome.storage.local.set({ [AUTO + automation.id]: automation });
    return automation;
  }

  async function deleteAutomation(id) {
    await chrome.storage.local.remove([AUTO + id, RUNS + id, VARS + id]);
  }

  async function getRuns(id) {
    const result = await chrome.storage.local.get(RUNS + id);
    return result[RUNS + id] || [];
  }

  async function addRun(id, run) {
    const runs = await getRuns(id);
    runs.unshift(run);
    await chrome.storage.local.set({ [RUNS + id]: runs.slice(0, 20) });
  }

  async function getSavedVars(id) {
    const result = await chrome.storage.local.get(VARS + id);
    return result[VARS + id] || {};
  }

  async function saveVars(id, values) {
    const kept = {};
    for (const [key, value] of Object.entries(values)) if (!isSecretName(key)) kept[key] = value;
    await chrome.storage.local.set({ [VARS + id]: kept });
  }

  const isSecretName = (name) => /pass|secret|\bpin\b|token|\botp\b/i.test(name);

  function variablesOf(automation) {
    const found = new Set();
    for (const step of automation.steps || []) {
      if (step.enabled === false) continue;
      for (const field of [step.value, step.url]) {
        if (typeof field !== "string") continue;
        for (const match of field.matchAll(VAR_RE)) found.add(match[1]);
      }
    }
    return [...found];
  }

  function fill(text, values) {
    if (typeof text !== "string") return text;
    return text.replace(VAR_RE, (match, key) => (values && values[key] != null ? String(values[key]) : match));
  }

  const hasPlaceholder = (text) => typeof text === "string" && new RegExp(VAR_RE.source).test(text);

  // Steps that act on an element of the page (a "key" step may also have one, but doesn't need it).
  const ELEMENT_TYPES = ["click", "type", "select", "check", "submit", "upload", "waitFor"];
  const needsElement = (step) => ELEMENT_TYPES.includes(step?.type);
  const hasElement = (step) => !!(step?.target?.selectors?.length || step?.target?.text);

  // A "type" or "select" step whose whole value is one {{Question}} is asked at each run.
  // The value typed while recording is kept in step.recordedValue and offered as the suggested answer.
  const ASKABLE = ["type", "select"];
  const PLACEHOLDER_ONLY = /^\{\{\s*([A-Za-z][\w .-]*?)\s*\}\}$/;
  function askedName(step) {
    if (!ASKABLE.includes(step?.type) || typeof step.value !== "string") return null;
    const match = step.value.match(PLACEHOLDER_ONLY);
    return match ? match[1] : null;
  }

  // Turns any label into a valid question name for {{…}}.
  function toVarName(text) {
    let name = String(text || "").replace(/[^\w .-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!/^[A-Za-z]/.test(name)) name = name ? `Value ${name}` : "Value";
    return name;
  }

  // Everything to ask before a run: [{ name, defaultValue, secret }]. Steps using the same name share one answer.
  function promptsOf(automation) {
    const prompts = new Map();
    for (const name of variablesOf(automation)) prompts.set(name, { name, defaultValue: "", secret: isSecretName(name) });
    for (const step of automation.steps || []) {
      if (step.enabled === false) continue;
      const prompt = prompts.get(askedName(step));
      if (!prompt) continue;
      if (step.secret) prompt.secret = true;
      if (!prompt.defaultValue && typeof step.recordedValue === "string") prompt.defaultValue = step.recordedValue;
    }
    for (const prompt of prompts.values()) if (prompt.secret) prompt.defaultValue = "";
    return [...prompts.values()];
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return (u.host + u.pathname).replace(/\/$/, "");
    } catch {
      return url || "";
    }
  }

  // How a step is named before its element is chosen.
  const UNPICKED = {
    click: "Click an element", type: "Type in a text field", select: "Choose an option in a list", check: "Tick a box",
    submit: "Submit a form", upload: "Upload a file", waitFor: "Wait for an element",
  };

  function describe(step) {
    if (UNPICKED[step.type] && !step.target?.label && !step.target?.text && !step.target?.selectors?.length) return UNPICKED[step.type];
    const label = step.target?.label || step.target?.text || "element";
    switch (step.type) {
      case "navigate": return step.auto ? `Page changes to ${shortUrl(step.url)}` : `Open ${shortUrl(step.url)}`;
      case "click": return `Click “${label}”`;
      case "type": return `Type in “${label}”${askedName(step) ? " · asked at each run" : ""}`;
      case "select": return `Choose an option in “${label}”${askedName(step) ? " · asked at each run" : ""}`;
      case "check": return `${step.value === "false" ? "Untick" : "Tick"} “${label}”`;
      case "key": return `Press ${step.value || "Enter"}`;
      case "submit": return "Submit the form";
      case "upload": return `Upload a file to “${label}”`;
      case "wait": return `Wait ${Math.round((step.ms || 1000) / 100) / 10}s`;
      case "waitFor": return `Wait until “${label}” appears`;
      default: return step.type;
    }
  }

  function newAutomation(fields = {}) {
    return {
      id: uid(),
      name: fields.name || "Untitled automation",
      description: fields.description || "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: { runIn: "newTab", speed: "normal", stepTimeout: 10, ...(fields.settings || {}) },
      steps: fields.steps || [],
    };
  }

  // Accepts one automation, an array, or { format: "tasktape", automations: [...] }.
  // Imported items always get new ids so nothing existing is overwritten.
  function parseImport(data) {
    const items = Array.isArray(data) ? data : Array.isArray(data?.automations) ? data.automations : [data];
    const result = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || !Array.isArray(item.steps)) continue;
      const steps = item.steps
        .filter((s) => s && STEP_TYPES.includes(s.type))
        .map((s) => ({
          id: uid(),
          type: s.type,
          enabled: s.enabled !== false,
          value: typeof s.value === "string" ? s.value : "",
          url: typeof s.url === "string" ? s.url : "",
          auto: !!s.auto,
          ms: Number(s.ms) || undefined,
          timeout: Number(s.timeout) || undefined,
          optionText: typeof s.optionText === "string" ? s.optionText : undefined,
          recordedValue: typeof s.recordedValue === "string" ? s.recordedValue : undefined,
          secret: s.secret === true ? true : undefined,
          multiple: s.multiple === true ? true : undefined,
          options: Array.isArray(s.options)
            ? s.options.slice(0, 100).filter((o) => o && typeof o.text === "string").map((o) => ({ value: String(o.value ?? ""), text: o.text }))
            : undefined,
          accept: typeof s.accept === "string" ? s.accept : undefined,
          target: s.target && Array.isArray(s.target.selectors)
            ? { selectors: s.target.selectors.filter((x) => typeof x === "string"), text: String(s.target.text || ""), tag: String(s.target.tag || ""), label: String(s.target.label || "") }
            : undefined,
        }));
      result.push(newAutomation({ name: String(item.name || "Imported automation"), description: String(item.description || ""), settings: item.settings, steps }));
    }
    return result;
  }

  function exportData(automations) {
    return {
      format: "tasktape",
      version: 1,
      exportedAt: new Date().toISOString(),
      automations: automations.map(({ id, createdAt, updatedAt, ...rest }) => rest),
    };
  }

  // Talk to the background worker from the popup / manager. Always resolves to { ok, result } or { ok: false, error }.
  // No answer usually means Chrome still runs an older background after TaskTape's files were updated.
  const NO_ANSWER = "TaskTape's background did not answer. If TaskTape was just updated, reload it: open chrome://extensions, press ↻ on the TaskTape card, then try again.";
  async function ask(message) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      return response ?? { ok: false, error: NO_ANSWER };
    } catch (error) {
      const text = error?.message || "";
      return { ok: false, error: /receiving end|port closed|channel closed|context invalidated/i.test(text) || !text ? NO_ANSWER : text };
    }
  }

  function timeAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const days = Math.round(s / 86400);
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return new Date(ms).toLocaleDateString();
  }

  return {
    AUTO, RUNS, VARS, STEP_TYPES, uid,
    listAutomations, getAutomation, saveAutomation, deleteAutomation,
    getRuns, addRun, getSavedVars, saveVars, isSecretName,
    ask, variablesOf, fill, hasPlaceholder, ELEMENT_TYPES, needsElement, hasElement, askedName, toVarName, promptsOf, describe, shortUrl, newAutomation, parseImport, exportData, timeAgo,
  };
})();

globalThis.TT = TT;
