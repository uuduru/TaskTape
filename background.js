// TaskTape background service worker: owns the recording session and runs replays.
importScripts("lib.js");

// ───────────────────────────── Session state ─────────────────────────────
// Kept in chrome.storage.session so it survives the service worker being suspended.
// state = { recording: { tabId, name, steps, lastInteractionAt } | null, run: { automationId, name, tabId, index, total, stop } | null }
const STATE_KEY = "state";
let state = null;
let activeRun = null; // in-memory marker: a replay loop is really running in this worker
let queue = Promise.resolve();

// Serialize every state change so steps sent quickly one after another are never lost.
function locked(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function load() {
  if (!state) {
    const stored = await chrome.storage.session.get(STATE_KEY);
    state = stored[STATE_KEY] || { recording: null, run: null };
    // A run whose worker was suspended cannot continue: forget it.
    if (state.run && !activeRun) {
      state.run = null;
      await persist();
    }
  }
  return state;
}

const persist = () => chrome.storage.session.set({ [STATE_KEY]: state });

// ───────────────────────────── Helpers ─────────────────────────────
// Sleeps without letting Chrome suspend the worker (any extension API call resets its idle timer).
async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10000, end - Date.now())));
    chrome.runtime.getPlatformInfo().catch(() => {});
  }
}

const sendToTab = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => null);

const isWebUrl = (url) => /^(https?|file):/i.test(url || "");

function sameUrl(a, b) {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}

async function waitComplete(tabId, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("The tab was closed.");
    if (tab.status === "complete") return;
    await sleep(200);
  }
}

// Tabs opened before TaskTape was installed do not have the content script yet: inject it.
async function ensureContent(tabId) {
  const pong = await sendToTab(tabId, { type: "TT_PING" });
  if (pong?.ok) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("The tab was closed.");
  if (!isWebUrl(tab.url)) throw new Error("TaskTape can't work on this page. Browser pages and the Chrome Web Store are protected.");
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => {});
}

// ───────────────────────────── Recording ─────────────────────────────
async function startRecording({ tabId, name }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("No tab to record.");
  if (!isWebUrl(tab.url)) throw new Error("Open the website where the task starts, then press Record. TaskTape can't record on this page.");
  await locked(async () => {
    await load();
    if (state.recording) throw new Error("A recording is already in progress.");
    if (state.run) throw new Error("Wait for the running automation to finish.");
    state.recording = {
      tabId,
      name: (name || "").trim(),
      startedAt: Date.now(),
      lastInteractionAt: 0,
      steps: [{ id: TT.uid(), type: "navigate", url: tab.url, auto: false, enabled: true }],
    };
    await persist();
  });
  await ensureContent(tabId);
  await sendToTab(tabId, { type: "TT_SET_RECORDING", on: true, count: 1 });
  return { ok: true };
}

function addStep(step, sender) {
  return locked(async () => {
    await load();
    const rec = state.recording;
    if (!rec || sender.tab?.id !== rec.tabId || sender.frameId !== 0 || !TT.STEP_TYPES.includes(step?.type)) return;
    const clean = { ...step, id: TT.uid(), enabled: true };
    const prev = rec.steps[rec.steps.length - 1];
    const sameField = prev?.type === "type" && clean.type === "type" && prev.target?.selectors?.[0] === clean.target?.selectors?.[0];
    if (sameField) rec.steps[rec.steps.length - 1] = { ...clean, id: prev.id };
    else rec.steps.push(clean);
    if (clean.type !== "wait") rec.lastInteractionAt = Date.now();
    await persist();
    sendToTab(rec.tabId, { type: "TT_SET_RECORDING", on: true, count: rec.steps.length });
  });
}

// URL changes in the recorded tab become "navigate" steps.
// If it happened right after a click/typing, it is marked "auto": on replay TaskTape waits for it instead of forcing it.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  locked(async () => {
    await load();
    const rec = state.recording;
    if (!rec || rec.tabId !== tabId) return;
    const last = rec.steps[rec.steps.length - 1];
    if (last?.type === "navigate" && sameUrl(last.url, info.url)) return;
    const auto = Date.now() - rec.lastInteractionAt < 5000;
    if (last?.type === "navigate" && last.auto && auto) last.url = info.url; // a redirect chain: keep the final page only
    else rec.steps.push({ id: TT.uid(), type: "navigate", url: info.url, auto, enabled: true });
    await persist();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  locked(async () => {
    await load();
    if (state.recording?.tabId === tabId) stopRecording(true, false).catch(() => {});
    if (state.run?.tabId === tabId) { state.run.stop = true; await persist(); }
  });
});

async function stopRecording(save = true, openEditor = true) {
  const tabId = (await load()).recording?.tabId;
  if (tabId != null) await sendToTab(tabId, { type: "TT_FLUSH" }); // send the text still being typed
  const rec = await locked(async () => {
    await load();
    const current = state.recording;
    state.recording = null;
    await persist();
    return current;
  });
  if (!rec) throw new Error("No recording in progress.");
  sendToTab(rec.tabId, { type: "TT_SET_RECORDING", on: false });
  if (!save || rec.steps.length <= 1) return { saved: false };
  const automation = TT.newAutomation({
    name: rec.name || `Recording ${new Date(rec.startedAt).toLocaleString()}`,
    steps: rec.steps,
  });
  await TT.saveAutomation(automation);
  if (openEditor) chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${automation.id}&new=1`) });
  return { saved: true, id: automation.id };
}

// ───────────────────────────── Replay ─────────────────────────────
const SPEED_DELAY = { slow: 1200, normal: 500, fast: 150 };

async function startRun({ id, variables = {}, where = "newTab", tabId: currentTabId }) {
  const automation = await TT.getAutomation(id);
  if (!automation) throw new Error("This automation no longer exists.");
  const steps = (automation.steps || [])
    .filter((s) => s.enabled !== false)
    .map((s) => ({ ...s, value: TT.fill(s.value, variables), url: TT.fill(s.url, variables) }));
  if (!steps.length) throw new Error("This automation has no steps to run.");
  const missing = steps.find((s) => TT.hasPlaceholder(s.value) || TT.hasPlaceholder(s.url));
  if (missing) throw new Error(`A value is missing for: ${TT.describe(missing)}`);
  await locked(async () => {
    await load();
    if (state.recording) throw new Error("Stop the recording before running an automation.");
    if (state.run) throw new Error(`“${state.run.name}” is already running.`);
    state.run = { automationId: id, name: automation.name, tabId: null, index: 0, total: steps.length, stop: false };
    await persist();
  });
  const token = {};
  activeRun = token;
  runLoop(automation, steps, where, currentTabId).finally(() => { if (activeRun === token) activeRun = null; });
  return { ok: true };
}

const UPLOAD_GIVE_UP_MS = 30 * 60 * 1000;

async function setWaiting(label) {
  await locked(async () => {
    await load();
    if (!state.run) return;
    state.run.waiting = label;
    await persist();
  });
}

// Upload steps pause the run: the page shows a panel, the user chooses the file, then the run goes on.
async function runUpload(step, tabId, timeoutMs, position) {
  const findMs = step.timeout ? step.timeout * 1000 : timeoutMs;
  const showPrompt = async () => {
    const end = Date.now() + findMs;
    let lastError = "";
    while (Date.now() < end) {
      if (state.run?.stop) return false;
      await ensureContent(tabId);
      const response = await sendToTab(tabId, { type: "TT_UPLOAD_PROMPT", step, position, timeout: Math.max(500, end - Date.now()) });
      if (response?.ok) return true;
      if (response && !response.retry) throw new Error(response.error);
      lastError = response?.error || "The page is still loading…";
      await sleep(300);
    }
    throw new Error(lastError || `Timed out: ${TT.describe(step)}`);
  };

  if (!(await showPrompt())) return;
  await setWaiting(step.target?.label || "file");
  // Bring the page to the front so the user sees the request.
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab?.windowId != null) chrome.windows?.update(tab.windowId, { focused: true }).catch(() => {});
  try {
    const giveUp = Date.now() + UPLOAD_GIVE_UP_MS;
    for (;;) {
      if (state.run?.stop) {
        await sendToTab(tabId, { type: "TT_UPLOAD_CANCEL" });
        return;
      }
      if (Date.now() > giveUp) {
        await sendToTab(tabId, { type: "TT_UPLOAD_CANCEL" });
        throw new Error("No file was chosen within 30 minutes.");
      }
      const status = await sendToTab(tabId, { type: "TT_UPLOAD_STATUS", stepId: step.id });
      if (status?.status === "done" || status?.status === "skipped") return;
      if (!status || status.status === "none") {
        // The page was reloaded or changed while waiting: show the request again on the new page.
        await waitComplete(tabId);
        if (!(await showPrompt())) return;
      }
      await sleep(700); // polling also keeps the service worker awake while the user chooses
    }
  } finally {
    await setWaiting(null);
  }
}

async function runStep(step, tabId, timeoutMs, position = "") {
  if (step.type === "upload") return runUpload(step, tabId, timeoutMs, position);
  if (step.type === "navigate") {
    if (step.auto) return waitComplete(tabId);
    const tab = await chrome.tabs.get(tabId);
    if (!sameUrl(tab.url, step.url)) {
      await chrome.tabs.update(tabId, { url: step.url });
      await sleep(300);
      await waitComplete(tabId);
    }
    return;
  }
  if (step.type === "wait") return sleep(step.ms || 1000);
  const deadline = Date.now() + (step.timeout ? step.timeout * 1000 : timeoutMs);
  let lastError = "";
  while (Date.now() < deadline) {
    if (state.run?.stop) return;
    await ensureContent(tabId);
    const response = await sendToTab(tabId, { type: "TT_EXECUTE", step, timeout: Math.max(500, deadline - Date.now()) });
    if (response?.ok) return;
    if (response && !response.retry) throw new Error(response.error);
    lastError = response?.error || "The page is still loading…";
    await sleep(300); // the page may be navigating: try again on the new page
  }
  throw new Error(lastError || `Timed out: ${TT.describe(step)}`);
}

async function runLoop(automation, steps, where, currentTabId) {
  const started = Date.now();
  let status = "success";
  let error = "";
  let failedIndex = -1;
  let tabId = null;
  const delay = SPEED_DELAY[automation.settings?.speed] ?? SPEED_DELAY.normal;
  const timeoutMs = (Number(automation.settings?.stepTimeout) || 10) * 1000;
  try {
    const startUrl = steps[0].type === "navigate" ? steps[0].url : null;
    if (where === "currentTab" && currentTabId != null) {
      tabId = currentTabId;
      if (startUrl) await chrome.tabs.update(tabId, { url: startUrl, active: true });
    } else if (startUrl) {
      tabId = (await chrome.tabs.create({ url: startUrl, active: true })).id;
    } else {
      if (currentTabId == null) throw new Error("This automation has no start page. Run it from the popup on the right page.");
      tabId = currentTabId;
    }
    await locked(async () => { await load(); if (state.run) { state.run.tabId = tabId; await persist(); } });
    await sleep(300);
    await waitComplete(tabId);
    for (let i = 0; i < steps.length; i++) {
      if (state.run?.stop) { status = "stopped"; break; }
      const step = steps[i];
      failedIndex = i;
      state.run.index = i + 1;
      persist();
      await ensureContent(tabId).catch(() => {});
      sendToTab(tabId, { type: "TT_RUN_STATUS", status: { name: automation.name, text: `${i + 1}/${steps.length} · ${TT.describe(step)}` } });
      await runStep(step, tabId, timeoutMs, `${i + 1}/${steps.length}`);
      if (state.run?.stop) { status = "stopped"; break; }
      await sleep(delay);
      await waitComplete(tabId);
    }
    if (status === "success") failedIndex = -1;
  } catch (e) {
    status = "failed";
    error = e?.message || String(e);
  }
  const failedStep = failedIndex >= 0 ? steps[failedIndex] : null;
  await TT.addRun(automation.id, {
    at: started,
    durationMs: Date.now() - started,
    status,
    error,
    failedStepId: status === "failed" && failedStep ? failedStep.id : null,
    failedStepNumber: status === "failed" ? failedIndex + 1 : null,
  });
  if (tabId != null) {
    const text = status === "success" ? "✓ Finished" : status === "stopped" ? "Stopped" : `✗ Step ${failedIndex + 1} failed: ${error}`;
    sendToTab(tabId, { type: "TT_RUN_STATUS", status: { name: automation.name, text, done: true, state: status } });
  }
  await locked(async () => { await load(); state.run = null; await persist(); });
}

async function stopRun() {
  await locked(async () => {
    await load();
    if (!state.run) throw new Error("Nothing is running.");
    state.run.stop = true;
    await persist();
  });
  return { ok: true };
}

async function hello(sender) {
  await load();
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId !== 0) return {};
  if (state.recording?.tabId === tabId) return { recording: true, count: state.recording.steps.length };
  if (state.run?.tabId === tabId) return { run: { name: state.run.name, text: state.run.waiting ? `${state.run.index}/${state.run.total} · waiting for your file` : `${state.run.index}/${state.run.total}` } };
  return {};
}

// ───────────────────────────── Messages ─────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    TT_HELLO: () => hello(sender),
    TT_STEP: () => addStep(message.step, sender),
    TT_GET_STATE: async () => { await load(); return state; },
    TT_START_RECORDING: () => startRecording(message),
    TT_STOP_RECORDING: () => stopRecording(message.save !== false),
    TT_RUN: () => startRun(message),
    TT_STOP_RUN: () => stopRun(),
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
