# TaskTape

**Record the browser tasks you repeat every day, then replay them in one click.**

TaskTape is a Chrome extension for people who do the same clicks and typing again and again: filling the same form, downloading the same report, creating the same ticket. Record the task once; next time, press ▶ Run and watch TaskTape do it.

No account, no server, no coding. Everything stays in your browser.

![The TaskTape manager showing a recorded automation with its steps](docs/images/manager.png)

## Features

- **One-click recording** of clicks, typing, drop-downs, checkboxes, the Enter/Escape keys, form submissions and page changes.
- **Reliable replay**: each element is remembered several ways (test ids, id, name, label, link, text, position). TaskTape waits for slow pages and elements before acting.
- **Values asked at run time**: write `{{Customer name}}` in a step, and TaskTape asks for it each time you run. Recorded passwords are **never stored**: they automatically become `{{… password}}` and are asked at each run.
- **File uploads**: when a step needs a file, the run pauses and a panel in the page asks you to choose it (or drop it). The run continues as soon as the file is attached. Files are never stored.
- **Step editor**: rename, reorder, disable, duplicate or delete steps, change typed text, add waits, open pages, press keys or wait for an element.
- **Run history** with the step that failed and why.
- **Import / export** as `.json` to share automations with colleagues.
- **On-page bar** while recording or running, with a Stop button.

## Install (developer mode)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome (or `edge://extensions` in Microsoft Edge).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `TaskTape` folder.
5. Pin the TaskTape icon in the toolbar.

After changing the code, click the ↻ reload button on the extension card.

## How to use

1. Open the website where your task starts.
2. Click the TaskTape icon, name your task and press **● Record on this page**.
3. Do the task once, normally.
4. Press **■ Stop** in the red bar at the bottom right of the page. The manager opens with your recorded steps.
5. Check the steps, then press **▶ Run**.

<p align="center">
  <img src="docs/images/popup.png" alt="The TaskTape popup: record a new task or run a saved one" width="320">
</p>

While recording, a red bar shows how many steps were captured. You can add a pause with **+ Wait 2s** or finish with **■ Stop**.

![Recording on a web page: the red TaskTape bar at the bottom right](docs/images/recording.png)

### Values that change at each run

In the manager, replace a typed text by a name between double braces, for example `{{Invoice number}}`. When you run the automation, TaskTape asks for the value. The last values you entered are remembered (except passwords, PINs and tokens).

### File uploads

When you pick a file during a recording, TaskTape records an **Upload** step and remembers only the file name, as a reminder.

![A run paused on an upload step, asking the user to choose the file](docs/images/upload.png)

On each run, TaskTape pauses at that step, brings the page to the front and shows a **Choose the file** panel. Pick a file or drop one onto the panel, and the run continues. You can also **Skip this step** or **Stop the run** from the panel. While waiting, the popup shows the run as paused, with a **Show the page** button. If no file is chosen within 30 minutes, the run stops.

Uploads must go through a normal file field on the page. Drop zones that accept only drag-and-drop are not supported yet.

### Tips for reliable automations

- Use **Slow** speed while testing, then switch to **Normal** or **Fast**.
- If a step can't find its element, open ⚙ on that step. You can paste a better CSS selector (one per line, most reliable first) or adjust the visible text used as a fallback.
- Add a **Wait** or **Wait for an element** step after actions that take time, such as generating a report.
- A step marked **Page · Happens by itself** waits for the page to change after the previous click. Untick it to make TaskTape open that address directly.

## Limitations

- Works on normal websites (`http`, `https`, and local files if you allow file access). Browser pages (`chrome://…`) and the Chrome Web Store can't be automated, by Chrome's rules.
- Elements inside iframes and closed shadow DOM are not recorded yet.
- Drag-and-drop (including drop-only upload zones), hovering menus and right-clicks are not recorded.
- Captchas and two-factor prompts must be completed by a person.
- Keep the replay tab open until the run finishes.

## Privacy

TaskTape makes no network requests of its own and has no analytics. Automations and run history are stored with `chrome.storage.local`, in your browser profile only. Passwords typed during a recording are replaced by a placeholder and never saved. See [PRIVACY.md](PRIVACY.md).

## Project structure

| File | Role |
| --- | --- |
| `manifest.json` | Extension definition (Manifest V3) |
| `background.js` | Service worker: recording session, replay engine, run history |
| `content.js` | Injected into pages: records actions, executes steps, shows the on-page bar |
| `lib.js` | Shared helpers: storage, variables, step descriptions, import/export |
| `popup.html` / `popup.js` | Toolbar popup: record, run, list |
| `editor.html` / `editor.js` | Manager: edit steps, settings, history, import/export |
| `ui.css` | Shared styles |
| `icons/icon.svg` | Icon source |
| `docs/images/` | Screenshots used in this README |

## Publishing

**GitHub**: create a repository, push this folder and add a few screenshots or a short GIF of a recording to this README.

**Chrome Web Store** (one-time developer fee):

1. Export `icons/icon.svg` to PNG at 16, 48 and 128 px, save them as `icons/icon16.png`, `icons/icon48.png` and `icons/icon128.png`, then add this to `manifest.json`:
   ```json
   "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
   ```
2. Zip the folder contents (not the folder itself).
3. In the Chrome Web Store developer dashboard, upload the zip, add screenshots (1280×800), a description and a link to `PRIVACY.md`.
4. Explain the permissions: **access to all sites** is needed to record and replay on any website the user chooses; **scripting** injects the recorder into tabs opened before installation; **storage** saves automations locally.

The same zip can be published on the Microsoft Edge Add-ons store.

## Ideas for next versions

- Scheduled runs (every morning at 9:00) with `chrome.alarms`
- Running an automation once per row of a CSV file
- Recording inside iframes
- Assertions such as "check that this text appears"
- A keyboard shortcut to run a favourite automation

## License

MIT. See [LICENSE](LICENSE).
