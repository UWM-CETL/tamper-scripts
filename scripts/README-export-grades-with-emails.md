
# `Canvas-Export-Grades-With-Email.user.js` – README

## What it does
Adds an **“Export With Emails”** button to every Canvas Gradebook page.
Click once → download a CSV containing:

```
Student | Login ID (SIS) | Email | <each assignment score> | Final Grade
```

Only students who have at least one graded submission are included.

## Works with

Tampermonkey · **Violentmonkey** (recommended) · Greasemonkey 4+

## Quick install
1. Install a userscript manager (e.g. Violentmonkey from the Chrome / Firefox store).
2. Open the raw script URL and accept the “Install” prompt:
   `https://raw.githubusercontent.com/UWM-CETL/tamper-scripts/main/scripts/Canvas-Export-Grades-With-Email.user.js`
3. Refresh any Canvas gradebook. The new button appears next to Canvas’s own **Export** menu.

## Using it
* Visit your courses Gradebook.
* Click **Export With Emails** → confirm the warning → file downloads (UTF-8 CSV).
* Final Grade is taken from the course grading scheme; if the scheme is off, the column is blank.

## Updating / removing

Your script manager will alert you when a newer version is available.
Disable or delete the script from the manager’s dashboard at any time.

## License

MIT – do as you like; attribution appreciated.
