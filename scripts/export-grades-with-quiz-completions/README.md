# README for Canvas-Export-Grades-With-Email.user.js

## What it does

Adds an **“Export With Completion Dates”** button to every Canvas Gradebook page.

Click once to download a UTF-8 CSV containing:

```text
Student | Login ID (SIS) | Email | <assignment score> | <assignment completed at> | ... | Final Grade
````

Each assignment is exported as a pair of columns:

```text
Assignment Name | Assignment Name Completed At
```

Only students who have at least one graded submission or completion timestamp are included.

## What counts as a completion date

For regular Canvas assignments, the completion date comes from the assignment submission timestamp.

For Classic Quizzes, the script attempts to use the quiz completion timestamp when available.

For New Quizzes and other assignment-backed activities, the script falls back to the regular Canvas assignment submission timestamp.

If Canvas does not provide a submission or completion timestamp for a student’s activity, the completion-date cell is left blank.

## Installation

[Install this script](https://uwm-cetl.github.io/tamper-scripts/scripts/export-grades-with-quiz-completions/export-grades-with-quiz-completion.user.js)

## Using it

* Visit your course’s Gradebook.
* Click **Export With Completion Dates**.
* Confirm the warning.
* A UTF-8 CSV file downloads.

The exported file includes student emails, raw scores, completion timestamps, and final grades. It is intended for reporting and review only.

It is **not** formatted for re-import into Canvas.

## Notes

Final Grade is taken from the course grading scheme. If the grading scheme is not enabled, the Final Grade column may be blank.

Completion timestamps depend on what Canvas exposes through its APIs. In some cases, especially with external tools or unusual submission workflows, Canvas may not provide a usable completion timestamp.

## Updating / removing

Your script manager will alert you when a newer version is available.

Disable or delete the script from the manager’s dashboard at any time.

## License

MIT – do as you like; attribution appreciated.