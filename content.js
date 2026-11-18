// TaskTape content script: records what the user does on the page, and replays steps sent by the background worker.
(() => {
  if (window.__taskTapeLoaded) return;
  window.__taskTapeLoaded = true;

  let recording = false;
  let stepCount = 0;
  let lastSubmitTrigger = 0;
  const pendingInputs = new Map(); // element -> debounce timer

  // ───────────────────────────── Messaging ─────────────────────────────
  function send(message) {
    return new Promise((resolve) => {
      if (!chrome.runtime?.id) return resolve(null);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError; // page may outlive a reloaded extension
          resolve(response ?? null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ───────────────────────────── Element helpers ─────────────────────────────
  const esc = (value) => CSS.escape(String(value));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function isUnique(selector) {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  }

  // Auto-generated ids (React, MUI, Radix, long numbers/hashes) change between visits, so they are not used.
  function isStableId(id) {
    return !!id && id.length < 64 && !/\d{4,}|[0-9a-f]{8,}|^:|^(ember|react|mui|radix|headlessui|rc_|uid|id-)/i.test(id);
  }

  const textOf = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const isVisible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const TEXT_INPUT_TYPES = ["text", "email", "password", "search", "tel", "url", "number", "date", "time", "datetime-local", "month", "week"];
  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.includes((el.type || "text").toLowerCase());
    return el.isContentEditable === true;
  }

  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="treeitem"],[contenteditable="true"],[onclick]';
  const interactive = (el) => (el?.closest ? el.closest(INTERACTIVE) || el : el);

  function cssPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      if (current !== el && isStableId(current.id)) {
        parts.unshift(`#${esc(current.id)}`);
        return parts.join(" > ");
      }
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const selector = parts.join(" > ");
      if (isUnique(selector)) return selector;
      current = parent;
    }
    return parts.join(" > ");
  }

  function labelFor(el) {
    const aria = el.getAttribute?.("aria-label");
    if (aria) return aria.trim().slice(0, 80);
    if (el.labels && el.labels[0]) return textOf(el.labels[0]);
    const placeholder = el.getAttribute?.("placeholder");
    if (placeholder) return placeholder.slice(0, 80);
    const title = el.getAttribute?.("title");
    if (title) return title.slice(0, 80);
    if (!isTextField(el) && el.tagName !== "SELECT") {
      const text = textOf(el);
      if (text) return text;
    }
    return el.getAttribute?.("name") || el.tagName.toLowerCase();
  }

  // Several ways to find the element again, most reliable first. Replay tries them in order, then falls back to the visible text.
  function buildTarget(el) {
    const selectors = [];
    const tag = el.tagName.toLowerCase();
    const add = (selector) => { if (selector && !selectors.includes(selector) && isUnique(selector)) selectors.push(selector); };
    for (const attr of ["data-testid", "data-test", "data-qa", "data-cy"]) {
      const value = el.getAttribute(attr);
      if (value) add(`[${attr}="${esc(value)}"]`);
    }
    if (isStableId(el.id)) add(`#${esc(el.id)}`);
    const name = el.getAttribute("name");
    if (name) add(`${tag}[name="${esc(name)}"]`);
    const aria = el.getAttribute("aria-label");
    if (aria) add(`${tag}[aria-label="${esc(aria)}"]`);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) add(`${tag}[placeholder="${esc(placeholder)}"]`);
    const href = tag === "a" ? el.getAttribute("href") : null;
    if (href && !href.startsWith("javascript:") && href !== "#") add(`a[href="${esc(href)}"]`);
    const path = cssPath(el);
    if (path && !selectors.includes(path)) selectors.push(path);
    return { selectors, text: isTextField(el) || tag === "select" ? "" : textOf(el), tag, label: labelFor(el) };
  }

  function locate(target) {
    if (!target) return null;
    for (const selector of target.selectors || []) {
      let list;
      try { list = [...document.querySelectorAll(selector)]; } catch { continue; }
      if (!list.length) continue;
      const visible = list.filter(isVisible);
      if (visible.length === 1) return visible[0];
      if (visible.length > 1 && target.text) {
        const match = visible.find((el) => textOf(el) === target.text);
        if (match) return match;
      }
      if (list.length === 1) return list[0];
    }
    if (target.text) {
      const candidates = [...document.querySelectorAll(target.tag || "*")].filter((el) => isVisible(el) && textOf(el) === target.text);
      if (candidates.length) return candidates[candidates.length - 1]; // deepest match in document order
    }
    return null;
  }

  async function waitForTarget(target, timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const el = locate(target);
      if (el) return el;
      if (Date.now() >= deadline) return null;
      await sleep(150);
    }
  }

  // The choices of a drop-down list, so the manager can offer them in a list.
  const optionsOf = (select) => [...select.options].slice(0, 100).map((o) => ({ value: o.value, text: o.text.trim() }));

  // ───────────────────────────── Recording ─────────────────────────────
  function emit(step) {
    if (!recording) return;
    stepCount += 1;
    updateIndicator();
    send({ type: "TT_STEP", step });
  }

  function variableNameFor(el) {
    const base = labelFor(el).replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    return /^[A-Za-z]/.test(base) ? (/pass/i.test(base) ? base : `${base} password`).slice(0, 40) : "Password";
  }

  function emitType(el) {
    const isPassword = el.tagName === "INPUT" && el.type === "password";
    const value = isPassword ? `{{${variableNameFor(el)}}}` : el.isContentEditable ? el.innerText : el.value;
    emit({ type: "type", target: buildTarget(el), value, ...(isPassword ? { secret: true } : {}) });
  }

  function flushInputs() {
    for (const [el, timer] of pendingInputs) {
      clearTimeout(timer);
      emitType(el);
    }
    pendingInputs.clear();
  }

  function isSubmitter(el) {
    if (el.tagName === "INPUT") return ["submit", "image"].includes(el.type);
    if (el.tagName === "BUTTON") return (el.getAttribute("type") || "submit").toLowerCase() === "submit" && !!el.form;
    return false;
  }

  const fromPage = (event) => !(indicatorHost && event.composedPath().includes(indicatorHost));

  document.addEventListener("click", (event) => {
    if (!recording || !event.isTrusted || !fromPage(event)) return;
    const el = interactive(event.target);
    if (!el || el.nodeType !== 1) return;
    if (isTextField(el) || el.tagName === "SELECT" || el.tagName === "OPTION") return; // typing / choosing is recorded instead
    if (el.tagName === "INPUT" && ["checkbox", "radio", "file"].includes(el.type)) return; // recorded on "change"
    if (el.tagName === "LABEL" && el.control && (isTextField(el.control) || ["checkbox", "radio", "file"].includes(el.control.type))) return;
    flushInputs();
    if (isSubmitter(el)) lastSubmitTrigger = Date.now();
    emit({ type: "click", target: buildTarget(el) });
  }, true);

  document.addEventListener("input", (event) => {
    if (!recording || !event.isTrusted) return;
    const el = event.target;
    if (!isTextField(el)) return;
    clearTimeout(pendingInputs.get(el));
    pendingInputs.set(el, setTimeout(() => { pendingInputs.delete(el); emitType(el); }, 600));
  }, true);

  document.addEventListener("change", (event) => {
    if (!recording || !event.isTrusted) return;
    const el = event.target;
    if (el.tagName === "INPUT" && el.type === "file") {
      // Only the file names are kept, as a reminder. The file itself is chosen again by the user at each run.
      flushInputs();
      const names = [...(el.files || [])].map((file) => file.name);
      if (names.length) emit({ type: "upload", target: buildTarget(el), value: names.join(", "), multiple: !!el.multiple, accept: el.accept || "" });
      return;
    }
    if (el.tagName === "SELECT") {
      flushInputs();
      const option = el.options[el.selectedIndex];
      emit({ type: "select", target: buildTarget(el), value: el.value, optionText: option ? option.text.trim() : "", options: optionsOf(el) });
    } else if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) {
      flushInputs();
      emit({ type: "check", target: buildTarget(el), value: String(el.checked) });
    } else if (isTextField(el)) {
      clearTimeout(pendingInputs.get(el));
      pendingInputs.delete(el);
      emitType(el); // the background merges it with the previous typing on the same field
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!recording || !event.isTrusted || !fromPage(event)) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    if (event.key === "Enter" && event.target?.tagName === "TEXTAREA") return; // a new line, already part of the typed text
    flushInputs();
    const el = event.target && event.target !== document.body ? event.target : null;
    emit({ type: "key", value: event.key, target: el ? buildTarget(el) : undefined });
  }, true);

  document.addEventListener("submit", (event) => {
    if (!recording || Date.now() - lastSubmitTrigger < 1500) return; // the recorded click on the submit button replays the submission
    flushInputs();
    emit({ type: "submit", target: buildTarget(event.target) });
  }, true);

  // ───────────────────────────── Replay ─────────────────────────────
  function flash(el) {
    const rect = el.getBoundingClientRect();
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px`,
      border: "2px solid #4f46e5", borderRadius: "6px", background: "rgba(79,70,229,.08)", zIndex: "2147483646", pointerEvents: "none",
      transition: "opacity .4s",
    });
    document.documentElement.appendChild(box);
    setTimeout(() => { box.style.opacity = "0"; }, 450);
    setTimeout(() => box.remove(), 900);
  }

  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.click();
  }

  function setValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, value);
      return;
    }
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value; // native setter so React/Vue notice the change
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9 };
  function pressKey(el, key) {
    const code = KEY_CODES[key] || 0;
    for (const type of ["keydown", "keypress", "keyup"]) {
      if (type === "keypress" && key !== "Enter") continue;
      el.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true }));
    }
  }

  async function execute(step, timeout) {
    const needsTarget = !(step.type === "key" && !step.target?.selectors?.length);
    let el = null;
    if (needsTarget) {
      el = await waitForTarget(step.target, timeout);
      if (!el) return { ok: false, retry: true, error: `Could not find “${step.target?.label || step.target?.text || "the element"}” on the page.` };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      flash(el);
    }
    switch (step.type) {
      case "waitFor":
        break;
      case "click":
        realClick(el);
        break;
      case "type": {
        const field = isTextField(el) ? el : el.querySelector("input,textarea,[contenteditable='true']") || el;
        setValue(field, step.value ?? "");
        break;
      }
      case "select": {
        if (el.tagName !== "SELECT") return { ok: false, error: "The recorded element is not a drop-down list anymore." };
        const options = [...el.options];
        const option = options.find((o) => o.value === step.value) || options.find((o) => o.text.trim() === (step.optionText || step.value));
        if (!option) return { ok: false, error: `The option “${step.optionText || step.value}” does not exist in “${step.target?.label}”.` };
        setValue(el, option.value);
        break;
      }
      case "check": {
        const wanted = step.value !== "false";
        if (el.checked !== wanted) realClick(el);
        break;
      }
      case "key":
        pressKey(el || document.activeElement || document.body, step.value || "Enter");
        break;
      case "submit": {
        const form = el.tagName === "FORM" ? el : el.closest("form");
        if (!form) return { ok: false, error: "No form found to submit." };
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
        break;
      }
      default:
        return { ok: false, error: `Unknown step type: ${step.type}` };
    }
    return { ok: true };
  }

  // ───────────────────────────── Upload prompt ─────────────────────────────
  // A web page can't fill a file field by itself, so the run pauses here: the user picks (or drops) the file in
  // this panel, TaskTape puts it into the page's file field, and the background worker sees "done" and continues.
  let upload = null; // { stepId, status: "waiting" | "done" | "skipped", host }

  function closeUploadPrompt() {
    upload?.host?.remove();
    if (upload) upload.host = null;
  }

  async function promptUpload(step, timeout, position) {
    if (upload && upload.stepId === step.id && upload.status === "waiting" && upload.host?.isConnected) return { ok: true };
    const found = await waitForTarget(step.target, timeout);
    const label = step.target?.label || "file field";
    if (!found) return { ok: false, retry: true, error: `Could not find the file field “${label}” on the page.` };
    if (!(found instanceof HTMLInputElement) || found.type !== "file") return { ok: false, error: `“${label}” is not a file field anymore.` };
    if (isVisible(found)) { found.scrollIntoView({ block: "center", behavior: "instant" }); flash(found); }

    closeUploadPrompt();
    upload = { stepId: step.id, status: "waiting", host: null };
    const host = document.createElement("div");
    host.setAttribute("data-tasktape", "");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .panel { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 2147483647; width: min(440px, calc(100vw - 32px));
                 background: #fff; color: #334155; border: 2px solid #4f46e5; border-radius: 14px; padding: 16px 18px; box-shadow: 0 18px 50px rgba(15,23,42,.35);
                 font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
        .panel.drag { background: #eef2ff; border-style: dashed; }
        .eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: #4f46e5; }
        h3 { margin: 4px 0 4px; font-size: 15px; color: #0f172a; }
        .recorded { font-size: 12px; color: #64748b; margin: 0 0 12px; }
        .error { color: #dc2626; font-weight: 600; font-size: 12px; margin: 0 0 8px; }
        .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .btn { all: unset; cursor: pointer; border-radius: 8px; padding: 8px 13px; font-weight: 700; border: 1px solid #e2e8f0; color: #0f172a; background: #fff; }
        .btn:hover { background: #f1f5f9; }
        .btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
        .btn.primary:hover { background: #4338ca; }
        .btn.stop { margin-left: auto; color: #dc2626; border-color: #fecaca; }
        input[type=file] { display: none; }
        .drop { font-size: 11px; color: #94a3b8; margin-top: 10px; }
      </style>
      <div class="panel" role="dialog" aria-live="assertive">
        <div class="eyebrow"></div>
        <h3></h3>
        <p class="recorded"></p>
        <p class="error" hidden></p>
        <div class="row">
          <label class="btn primary">📎 Choose file…<input type="file"></label>
          <button class="btn skip" type="button">Skip this step</button>
          <button class="btn stop" type="button">■ Stop run</button>
        </div>
        <div class="drop">You can also drop the file onto this box.</div>
      </div>`;
    const panel = shadow.querySelector(".panel");
    const picker = shadow.querySelector("input[type=file]");
    const errorBox = shadow.querySelector(".error");
    shadow.querySelector(".eyebrow").textContent = `TaskTape · step ${position || ""} · your turn`;
    shadow.querySelector("h3").textContent = `Choose the file for “${label}”`;
    shadow.querySelector(".recorded").textContent = step.value ? `When recording, you used: ${step.value}` : "The run continues as soon as the file is chosen.";
    if (step.multiple) picker.multiple = true;
    if (step.accept) picker.accept = step.accept;

    const apply = (files) => {
      if (!files || !files.length) return;
      // The page may have re-drawn the field while the user was choosing: find it again if needed.
      const field = found.isConnected ? found : locate(step.target);
      try {
        if (!field) throw new Error("the file field disappeared from the page");
        const transfer = new DataTransfer();
        for (const file of field.multiple ? [...files] : [files[0]]) transfer.items.add(file);
        field.files = transfer.files;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        upload.status = "done";
        closeUploadPrompt();
      } catch (error) {
        errorBox.hidden = false;
        errorBox.textContent = `Could not attach the file: ${error?.message || error}`;
      }
    };
    picker.addEventListener("change", () => apply(picker.files));
    panel.addEventListener("dragover", (e) => { e.preventDefault(); panel.classList.add("drag"); });
    panel.addEventListener("dragleave", () => panel.classList.remove("drag"));
    panel.addEventListener("drop", (e) => { e.preventDefault(); panel.classList.remove("drag"); apply(e.dataTransfer?.files); });
    shadow.querySelector(".skip").addEventListener("click", () => { upload.status = "skipped"; closeUploadPrompt(); });
    shadow.querySelector(".stop").addEventListener("click", () => { closeUploadPrompt(); send({ type: "TT_STOP_RUN" }); });

    document.documentElement.appendChild(host);
    upload.host = host;
    return { ok: true };
  }

  // ───────────────────────────── Element picker ─────────────────────────────
  // Used by the manager ("Pick on page") to choose the element of a step added by hand, or to fix a step.
  // While picking, clicks select an element instead of reaching the page. "Pause" lets the user navigate first.
  let picker = null; // { kind, status: "picking" | "done" | "cancelled", result, host, cleanup }

  const isCheckInput = (el) => el?.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
  const isFileInput = (el) => el?.tagName === "INPUT" && el.type === "file";
  const PICK_RULES = {
    type: { test: isTextField, need: "a text field" },
    select: { test: (el) => el?.tagName === "SELECT", need: "a drop-down list" },
    check: { test: isCheckInput, need: "a checkbox or a radio button" },
    upload: { test: isFileInput, need: "a file field or its upload button" },
  };

  // The user often clicks around the real field (its label, a wrapper, a custom "Upload" button): find the field.
  function resolvePick(kind, el) {
    if (!el || el.nodeType !== 1) return el;
    const control = el.tagName === "LABEL" ? el.control : el.closest?.("label")?.control;
    if (kind === "type") return isTextField(el) ? el : [el.querySelector?.("input,textarea,[contenteditable='true']"), control].find(isTextField) || el;
    if (kind === "select") return el.tagName === "SELECT" ? el : el.querySelector?.("select") || (control?.tagName === "SELECT" ? control : el);
    if (kind === "check") return isCheckInput(el) ? el : [el.querySelector?.("input[type=checkbox],input[type=radio]"), control].find(isCheckInput) || el;
    if (kind === "upload") {
      if (isFileInput(el)) return el;
      const near = [el.querySelector?.("input[type=file]"), control, el.parentElement?.querySelector?.("input[type=file]")].find(isFileInput);
      if (near) return near;
      const all = document.querySelectorAll("input[type=file]");
      return all.length === 1 ? all[0] : el; // most pages have a single (often hidden) file field
    }
    if (kind === "submit") return el.closest?.("form") || el;
    return el;
  }

  function pickInfo(el) {
    const info = { tag: el.tagName.toLowerCase(), isPassword: el.tagName === "INPUT" && el.type === "password", multiple: !!el.multiple, accept: el.accept || "" };
    if (el.tagName === "SELECT") {
      const option = el.options[el.selectedIndex];
      info.options = optionsOf(el);
      info.currentValue = el.value;
      info.currentText = option ? option.text.trim() : "";
    } else if (isCheckInput(el)) {
      info.checked = el.checked;
    } else if (isTextField(el) && !info.isPassword) {
      info.currentValue = el.isContentEditable ? el.innerText : el.value;
    }
    return info;
  }

  function stopPick(status) {
    if (!picker) return;
    picker.cleanup?.();
    picker.cleanup = null;
    picker.host?.remove();
    picker.host = null;
    if (status) picker.status = status;
  }

  function startPick(kind, hint) {
    if (picker?.status === "picking" && picker.kind === kind && picker.host?.isConnected) return;
    stopPick();
    const host = document.createElement("div");
    host.setAttribute("data-tasktape", "");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .bar { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647; display: flex; gap: 12px; align-items: center;
               background: #312e81; color: #fff; border-radius: 12px; padding: 10px 12px 10px 16px; width: max-content; max-width: min(820px, calc(100vw - 32px));
               font: 600 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
        .sub { font-weight: 500; opacity: .85; font-size: 12px; }
        .sub.warn { color: #fecaca; opacity: 1; font-weight: 700; }
        .actions { display: flex; gap: 6px; flex: none; }
        button { all: unset; cursor: pointer; background: rgba(255,255,255,.18); padding: 5px 10px; border-radius: 7px; font-weight: 700; white-space: nowrap; }
        button:hover { background: rgba(255,255,255,.3); }
        .box { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #4f46e5; background: rgba(79,70,229,.12); border-radius: 4px; display: none; }
        .box.bad { border-color: #dc2626; background: rgba(220,38,38,.08); }
        .tag { position: absolute; left: -2px; top: -24px; background: #4f46e5; color: #fff; font: 600 11px system-ui, sans-serif; padding: 2px 6px;
               border-radius: 4px; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
        .box.bad .tag { background: #dc2626; }
      </style>
      <div class="box"><span class="tag"></span></div>
      <div class="bar">
        <div><div class="title"></div><div class="sub"></div></div>
        <div class="actions"><button type="button" class="pause">Pause to navigate</button><button type="button" class="cancel">Cancel (Esc)</button></div>
      </div>`;
    const box = shadow.querySelector(".box");
    const tag = shadow.querySelector(".tag");
    const sub = shadow.querySelector(".sub");
    const pauseButton = shadow.querySelector(".pause");
    const rule = PICK_RULES[kind];
    const defaultSub = "Clicks choose an element instead of using the page. Need another page first? Press Pause.";
    shadow.querySelector(".title").textContent = `TaskTape · click ${hint || "the element for this step"}`;
    sub.textContent = defaultSub;

    let paused = false;
    const isOurs = (e) => e.composedPath().includes(host);
    const candidate = (e) => resolvePick(kind, interactive(e.target) || e.target);
    const onMove = (e) => {
      if (paused || isOurs(e)) { box.style.display = "none"; return; }
      const el = candidate(e);
      if (!el?.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      box.classList.toggle("bad", !!rule && !rule.test(el));
      tag.textContent = `${el.tagName.toLowerCase()} · ${labelFor(el)}`;
    };
    const block = (e) => {
      if (paused || isOurs(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      if (paused || isOurs(e)) return;
      block(e);
      const el = candidate(e);
      if (rule && !rule.test(el)) {
        sub.textContent = `That's not ${rule.need}. Please click ${rule.need}.`;
        sub.classList.add("warn");
        return;
      }
      picker.result = { target: buildTarget(el), info: pickInfo(el) };
      stopPick("done");
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stopPick("cancelled");
    };
    const blocked = ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick", "contextmenu", "auxclick", "submit"];
    for (const type of blocked) window.addEventListener(type, block, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("keydown", onKey, true);

    pauseButton.addEventListener("click", () => {
      paused = !paused;
      pauseButton.textContent = paused ? "Resume picking" : "Pause to navigate";
      sub.classList.remove("warn");
      sub.textContent = paused ? "Paused: use the page normally, then press Resume picking." : defaultSub;
      if (paused) box.style.display = "none";
    });
    shadow.querySelector(".cancel").addEventListener("click", () => stopPick("cancelled"));

    picker = {
      kind, status: "picking", result: null, host,
      cleanup: () => {
        for (const type of blocked) window.removeEventListener(type, block, true);
        window.removeEventListener("click", onClick, true);
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("keydown", onKey, true);
      },
    };
    document.documentElement.appendChild(host);
  }

  // ───────────────────────────── On-page indicator ─────────────────────────────
  let indicatorHost = null;
  let indicatorState = null; // { mode: "record" } | { mode: "run", text, name, done?, state? }
  let hideTimer = null;

  function updateIndicator() {
    if (!indicatorState) {
      indicatorHost?.remove();
      indicatorHost = null;
      return;
    }
    if (!indicatorHost) {
      indicatorHost = document.createElement("div");
      indicatorHost.setAttribute("data-tasktape", "");
      const shadow = indicatorHost.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          .bar { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center; gap: 8px;
                 padding: 8px 10px 8px 12px; border-radius: 10px; color: #fff; font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
                 box-shadow: 0 8px 24px rgba(0,0,0,.25); max-width: 420px; }
          .rec { background: #b91c1c; } .run { background: #312e81; } .ok { background: #15803d; } .bad { background: #b91c1c; }
          .dot { width: 9px; height: 9px; border-radius: 50%; background: #fff; flex: none; }
          .rec .dot { animation: pulse 1.2s infinite; }
          @keyframes pulse { 50% { opacity: .3; } }
          .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          button { all: unset; cursor: pointer; background: rgba(255,255,255,.18); padding: 4px 9px; border-radius: 6px; font-weight: 700; white-space: nowrap; }
          button:hover { background: rgba(255,255,255,.3); }
        </style>
        <div class="bar"><span class="dot"></span><span class="text"></span><span class="actions"></span></div>`;
      document.documentElement.appendChild(indicatorHost);
    }
    const shadow = indicatorHost.shadowRoot;
    const bar = shadow.querySelector(".bar");
    const text = shadow.querySelector(".text");
    const actions = shadow.querySelector(".actions");
    actions.textContent = "";
    const button = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      actions.appendChild(b);
    };
    if (indicatorState.mode === "record") {
      bar.className = "bar rec";
      text.textContent = `Recording · ${stepCount} step${stepCount === 1 ? "" : "s"}`;
      button("+ Wait 2s", () => { flushInputs(); emit({ type: "wait", ms: 2000 }); });
      button("■ Stop", () => { flushInputs(); send({ type: "TT_STOP_RECORDING", save: true }); });
    } else {
      bar.className = `bar ${indicatorState.done ? (indicatorState.state === "success" ? "ok" : "bad") : "run"}`;
      text.textContent = `${indicatorState.name ? indicatorState.name + " · " : ""}${indicatorState.text}`;
      if (!indicatorState.done) button("■ Stop", () => send({ type: "TT_STOP_RUN" }));
    }
  }

  function setRecording(on, count) {
    recording = on;
    if (typeof count === "number") stepCount = count;
    if (!on) flushInputs();
    indicatorState = on ? { mode: "record" } : null;
    updateIndicator();
  }

  function setRunStatus(status) {
    clearTimeout(hideTimer);
    indicatorState = status ? { mode: "run", ...status } : null;
    updateIndicator();
    if (status?.done) hideTimer = setTimeout(() => { indicatorState = null; updateIndicator(); }, 4000);
  }

  // ───────────────────────────── Wiring ─────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "TT_PING":
        sendResponse({ ok: true });
        return false;
      case "TT_SET_RECORDING":
        setRecording(!!message.on, message.count);
        sendResponse({ ok: true });
        return false;
      case "TT_FLUSH":
        flushInputs();
        sendResponse({ ok: true });
        return false;
      case "TT_RUN_STATUS":
        setRunStatus(message.status);
        sendResponse({ ok: true });
        return false;
      case "TT_PICK_START":
        startPick(message.kind, message.hint);
        sendResponse({ ok: true });
        return false;
      case "TT_PICK_STATUS":
        sendResponse({ status: picker ? picker.status : "none", result: picker?.result ?? null });
        return false;
      case "TT_PICK_CANCEL":
        stopPick("cancelled");
        sendResponse({ ok: true });
        return false;
      case "TT_UPLOAD_PROMPT":
        promptUpload(message.step, message.timeout || 10000, message.position)
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
      case "TT_UPLOAD_STATUS":
        sendResponse({ status: upload && upload.stepId === message.stepId ? upload.status : "none" });
        return false;
      case "TT_UPLOAD_CANCEL":
        closeUploadPrompt();
        upload = null;
        sendResponse({ ok: true });
        return false;
      case "TT_EXECUTE":
        execute(message.step, message.timeout || 10000)
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
      default:
        return false;
    }
  });

  // After every page load, ask whether this tab is being recorded or replayed.
  send({ type: "TT_HELLO" }).then((response) => {
    const info = response?.result;
    if (info?.recording) setRecording(true, info.count);
    else if (info?.run) setRunStatus(info.run);
  });
})();
