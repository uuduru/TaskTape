# Contributing to TaskTape

Thanks for your interest! Every contribution helps, not only code.

## Ways to help

- **Report a problem**: [open an issue](https://github.com/uuduru/TaskTape/issues/new/choose) and follow the form.
- **Suggest an idea**: tell us which repetitive task you want to automate.
- **Answer questions** in [Discussions](https://github.com/uuduru/TaskTape/discussions).
- **Improve the docs**: unclear sentence, missing tip, typo… pull requests are welcome.

## Working on the code

TaskTape is plain JavaScript with no build step.

1. Fork the repository and clone your fork.
2. Load the folder in `chrome://extensions` (Developer mode → **Load unpacked**).
3. After each change, click ↻ on the extension card and reload the page you test on.
4. Keep pull requests small and focused, and describe how you tested them.

Where things live:

- `content.js`: recording and replaying on the page
- `background.js`: recording sessions and the run engine
- `popup.*` and `editor.*`: the user interface
- `lib.js`: shared helpers

## Ground rules

- Never store passwords or file contents.
- No network requests, tracking or analytics. Everything stays in the user's browser.
- Be kind and patient in issues and discussions.
