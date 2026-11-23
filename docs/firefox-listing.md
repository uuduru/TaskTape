# Firefox Add-ons (addons.mozilla.org): texts to paste

## Name
TaskTape – Record & Replay Browser Tasks

## Summary (max 250 characters)
Record the clicks and typing you repeat every day, then replay them in one click. Asks for changing values and files at run time. No code, no account: everything stays in your browser.

## Description
Do you fill in the same web forms, click through the same pages or download the same reports again and again? Record the task once with TaskTape. Next time, press Run and watch it happen.

**How it works**
1. Open the website where your task starts and press Record.
2. Do the task once, as usual.
3. Press Stop. Your steps appear in plain language ("Type in Supplier", "Click Submit invoice").
4. Next time, press Run.

**Made for real office tasks**
• Values that change each time (an invoice number, a customer): mark the step "Ask each run" and TaskTape asks before running, suggesting the last value.
• File uploads: the run pauses and lets you choose the file, then continues.
• Pages that load more content as you scroll: add a Scroll step.
• Add or fix a step by simply clicking the element on the website.
• Run history shows which step failed and why.
• Share automations with colleagues by export / import.

**Private by design**
• No account, no server, no analytics. Automations are stored in your browser only.
• Passwords typed while recording are never stored; they are asked at each run.
• Free and open source (MIT): https://github.com/uuduru/TaskTape

Limits: browser pages and add-on stores can't be automated, by Firefox's rules. Captchas and two-factor prompts must be completed by a person.

## Categories
Productivity (or "Other" if Productivity isn't offered); you can add "Web Development" as a second one.

## Support
- Support site: https://github.com/uuduru/TaskTape/issues
- Homepage: https://github.com/uuduru/TaskTape

## License
MIT License

## Privacy policy
Paste the content of PRIVACY.md.

## Screenshots (in docs/images/)
1. manager.png – the step editor
2. recording.png – recording on a website
3. upload.png – a run paused for a file upload
4. pick.png – choosing an element on the website
5. popup.png – the toolbar popup

## Notes to reviewer
TaskTape records and replays actions on websites chosen by the user.

Permissions:
- host permission <all_urls>: to record and replay on any website where the user starts a recording or a run. It is requested at the moment of use if not already granted.
- scripting: to add the recorder to tabs that were open before installation.
- storage: automations and run history are stored locally (storage.local / storage.session).

The extension makes no network requests of its own and collects no data. The code is plain JavaScript, not minified or bundled; the files in the package are the source code (also on https://github.com/uuduru/TaskTape).

How to test:
1. Open any website with a form (for example https://httpbin.org/forms/post).
2. Click the TaskTape icon, then "Record on this page". Fill in a field, tick a box and click a button.
3. Click "Stop" in the red bar at the bottom right. The manager opens with the steps.
4. Click "Run": a new tab opens and the steps are replayed.
