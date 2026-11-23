# Chrome Web Store: texts and images to use

Images are in `docs/store/chrome/`:
- **Store icon (128×128):** `docs/store/chrome/store-icon-128.png` (96×96 artwork centred with 16 px transparent padding, as Google's image guidelines recommend)
- **Screenshots (1280×800):** `1-manager.png`, `2-recording.png`, `3-upload.png`, `4-pick.png`, `5-popup.png`
- **Small promo tile (440×280):** `promo-small-440x280.png`

---

## Store listing tab

**Description:** use the same text as in `docs/firefox-listing.md` (Description section), replacing "by Firefox's rules" with "by Chrome's rules".

**Category:** Productivity → Workflow & Planning (or Tools)

**Language:** English

**Official URL / Homepage:** https://github.com/uuduru/TaskTape
**Support URL:** https://github.com/uuduru/TaskTape/issues

The short description under the name comes from `description` in `manifest.json`.

---

## Privacy practices tab

### Single purpose
TaskTape records the actions a user performs on a web page (clicks, typing, choices, uploads) and replays them later on the user's request, to automate repetitive browser tasks.

### Permission justifications

**storage**
Saves the user's recorded automations, their settings and the history of their runs locally in the browser (chrome.storage.local), and the state of a recording or run in progress (chrome.storage.session). Nothing is sent to any server.

**scripting**
Adds TaskTape's recorder/player script to a tab that was already open before the extension was installed or updated, so the user can record or replay there without reloading the page. It only injects the extension's own file (content.js), never remote code.

**Host permission (`<all_urls>`)**
TaskTape is a general-purpose recorder: the user decides on which website to record and replay their task (for example a company intranet, a supplier portal or a webmail). The content script needs access to the page to record the user's clicks and typing and to replay them, and the extension needs to open/navigate the tab of an automation. It acts only on pages where the user starts a recording, a run, or picks an element.

### Remote code
**No, I am not using remote code.** All JavaScript is included in the package. The extension makes no network requests.

### Data usage
TaskTape has no server, no account and no analytics, and transmits nothing off the device. It does store, locally and only on the user's computer, what the user records:
- the addresses of the pages visited during a recording,
- the clicks and the text typed (passwords are never stored),
- the labels of the page elements used.

Google's form asks what data the extension "collects". Read the definition in Google's [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) when filling it in. If in doubt, declaring is safer than not declaring:

- [x] **Website content** (text typed into forms, labels of page elements)
- [x] **User activity** (clicks and keystrokes recorded by the user)
- [x] **Web history** (addresses of the pages in a recording)

Then tick the three certifications:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/uuduru/TaskTape/blob/main/PRIVACY.md

---

## Distribution tab
- **Visibility:** Public
- **Regions:** All regions
- **Pricing:** Free
