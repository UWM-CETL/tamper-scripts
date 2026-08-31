# Canvas Admin Tool Drawer

## What it does

Adds a dark, clearly marked admin tools icon to the upper-right corner of Canvas. Selecting the icon
opens an accessible drawer from the left side of the page.

The drawer contains three accordion contexts:

* **Admin** for account and subaccount tools.
* **Course** for course-level tools.
* **Page** for tools that act on a specific Canvas item, such as an assignment, quiz, discussion,
  module, file, user, section, or content page.

The script opens the context that is apparent from the current Canvas URL and fills in any numeric
Canvas ID it can determine. Course is the default when the context is ambiguous. Every context ID
field remains editable so an admin can target a different account, course, or item.

The Admin context currently contains **Courses**, **People**, and **Sub-Accounts** sub-accordions.
Its shared **Published courses only** scope is enabled by default and is applied to Admin reports that
operate on courses unless an action explicitly states otherwise. The section matcher intentionally
searches every non-deleted course in the selected terms. A grouped, multiple-selection **Terms**
scope provides flexible meta-options for
**All Current Terms** and **All Terms**, followed by the Canvas **Default Term** and individual
**Current Terms**, **Future Terms**, **Past Terms**, and **Undated Terms**. All Current Terms is the
safe default and can be combined with individual terms from the other groups. The selector excludes
root-account terms that Canvas reports are unused in the selected account or subaccount. All Terms
therefore means all terms used in that selected scope, not every consortium term. Dated terms are
ordered by `start_at` within each group.

Course tools are nested action accordions. This keeps each action's mappings, analysis, confirmation,
progress, and results separate while allowing the shared account and CSV scopes to be reused.

### Course navigation links report

Under **Admin → Courses**, **Get all navigation links** creates a CSV containing the available Canvas
navigation tabs for every course in the selected account scope. Each row includes the course Canvas
ID, course SIS ID, term Canvas ID, term SIS ID, course metadata, tab metadata, and both relative and
absolute navigation URLs. Canvas filters the course-list requests by each selected enrollment term
before the script begins collecting course tabs; choosing All Terms is the intentionally broad
exception.

Starting the report opens an inline Continue/Cancel confirmation. While it runs, the drawer displays
the number of courses checked, navigation links found, course errors, and the latest Canvas quota
remaining value. A failed course is recorded as an error row without discarding successful results
from other courses.

Report filenames use the compact pattern `nav.acct-<account-id>.<pub|unpub>.<timestamp>.csv`. `pub`
means the **Published courses only** filter was applied; `unpub` means that filter was disabled and
the report can contain courses in any publication state. Term scope is intentionally omitted from the
filename because it can represent multiple selections. The selected scope remains recorded in
`scope.enrollment_term_ids` and `scope.enrollment_term_names`, while each row identifies its course's
term through `term.id`, `term.sis_term_id`, and `term.name`.

### Sections and class numbers report

Under **Admin → Courses**, **Get sections and class numbers** matches a selected column in the
uploaded CSV against sections in the selected account and term scope. The global **Published courses
only** setting does not apply: the matcher searches both published and unpublished non-deleted
courses. The script asks Canvas to generate a server-side Provisioning report containing only
`sections.csv`; it does not enumerate courses or call the Sections API once per course. Canvas accepts
one enrollment term per report, so multiple selected terms are processed sequentially and then
combined before matching. **All Terms** uses one unfiltered Provisioning report.

Provisioning columns are mapped to the established API-style fields: `canvas_section_id` becomes
`section.id`, `section_id` becomes `section.sis_section_id`, `canvas_course_id` becomes `course.id`,
and `course_id` becomes `course.sis_course_id`. The script derives `match.class_number` from exactly
the final five digits of `section.sis_section_id`. Uploaded class numbers must contain exactly five
digits. Values remain strings throughout CSV processing so a leading zero present in the file is
preserved.

The result preserves every input column. `match.class_number_count` records how many scoped Canvas
sections matched that input row. A unique match is `matched`, no match is `no_match`, malformed input
is `invalid_class_number`, and every candidate for an ambiguous value is emitted as a separate
`multiple_matches` row. Report progress is polled through the Account Reports API, and failed term
reports are included as `report_error` rows rather than silently making the lookup appear complete.
Unmatched rows are marked `no_match_in_incomplete_scope` whenever any selected-term report failed.
The compact filename is
`sec-match.acct-<account-id>.unpub.<timestamp>.csv`; term scope remains in the CSV rather than the
filename, and `unpub` records that no published-only filter was applied.

### CSV input

The optional **CSV input** parses a local CSV in the browser; it does not send the file to a separate
service. Uploading establishes only the reusable rows and headers. Every field selector and parameter
mapping belongs to the action that consumes it and is displayed inside that action's accordion.
Column selectors never choose a field automatically; the user must make every mapping explicitly.
Duplicate or blank headers are rejected so later field mappings remain unambiguous.

### Show or hide course navigation

The **Show or hide course navigation** action requires four action-specific mappings:

* **Course ID column** identifies the destination course.
* **Course ID type** says whether that column contains Canvas or SIS course IDs.
* **Navigation tool ID column** contains Canvas tab IDs such as `context_external_tool_4`.
* **New hidden value column** uses the canonical Canvas `hidden` values below. These are the only
  accepted values; matching is case-insensitive so Excel's `TRUE` and `FALSE` are valid.

| CSV value | Requested result |
| --- | --- |
| `false` | Show the tab in course navigation |
| `true` | Hide the tab from course navigation |

**Analyze CSV** is read-only. It gets the current tabs for each unique course and classifies every
input row as will show, will hide, already shown, already hidden, unavailable, invalid, duplicate, or
API error. No write is made until the user confirms separate show and hide counts. Confirmed rows are
updated through the Canvas Tabs API with `hidden=false` to show them or `hidden=true` to hide them.
Conflicting values for the same course and tab are rejected rather than choosing one. Home and
Settings are reported as unavailable because Canvas does not allow those tabs to be hidden or moved.

For a tab that is already available in a course, `hidden` is the only value required to change whether
the tab is placed in course navigation. `position` is optional and controls ordering. This does not
override Canvas permissions or an external tool's own visibility configuration: a shown tab can still
be unavailable to a particular user role. The administrator running the action must also have
permission to manage course content.

After execution, a results CSV preserves the source columns and adds the returned `tab.*` fields plus
`run.action`, `run.completed_at`, `run.status`, and `run.error`. `run.action` is canonically
`set_navigation_hidden`; status values distinguish shown and hidden results. The shared scheduler
applies the same concurrency, quota, retry, and backoff controls used by reports.

The icon is only added when the current Canvas user can view at least one account through Canvas's
Accounts API. Canvas normally returns an empty account list for students and teachers. The result is
cached in the current browser tab for 15 minutes so normal Canvas navigation does not repeat the
check on every page load.

## Canvas API traffic controls

All REST API work in the drawer goes through one shared request scheduler. It:

* Allows at most 15 Canvas API requests to be active at once.
* Tracks Canvas's `X-Request-Cost` and `X-Rate-Limit-Remaining` response headers.
* Briefly pauses new work when the remaining quota reaches the configured safety threshold.
* Honors `Retry-After` when Canvas supplies it.
* Retries throttled, timed-out, and transient server responses with exponential backoff and jitter.
* Stops after five retries and returns a detailed error to the calling tool.
* Provides a pagination helper that follows Canvas `Link` headers through the same scheduler.
* Supports both ordinary paginated arrays and Canvas's named response envelopes, including the
  `enrollment_terms` response.
* Provides both a streaming page iterator and an accumulating `getAll` helper.
* Stops pagination cycles and handles Canvas responses where `rel="next"` and `rel="last"` identify
  the same terminal page.

The scheduler also handles same-origin credentials, Canvas CSRF tokens for write operations, form
encoding, and string-safe Canvas IDs. Future tools should use this shared client rather than calling
`fetch` directly.

CSV generation is also shared. The utility accepts reusable column definitions, preserves Canvas and
SIS IDs as strings, adds an Excel-compatible UTF-8 marker, escapes values, and neutralizes cells that
spreadsheet applications might otherwise interpret as formulas.

CSV fields use short, dot-delimited namespaces. Fields copied from Canvas retain the exact JSON key
after a source namespace, such as `course.id`, `course.sis_course_id`, `term.sis_term_id`, and
`tab.visibility`. Script-created metadata uses `scope.*` and `run.*`. This convention is required for
future reports so source fields remain recognizable and reusable without another mapping layer.

## Installation

[Install this script](https://uwm-cetl.github.io/tamper-scripts/scripts/admin-tool-drawer/admin-tool-drawer.user.js)

## Using it

1. Sign in to a Canvas site hosted on `instructure.com` with an account-admin role.
2. Select the tools icon in the upper-right corner.
3. Confirm or enter the Canvas ID in the relevant Admin, Course, or Page accordion.
4. For the navigation report, open **Admin → Courses → Get all navigation links**, select the term
   scope and whether to limit the scope to published courses, and prepare the report.
5. For a CSV-driven action, upload the CSV in the Admin scope, map its course ID column, then open the
   action accordion and provide the action-specific column mappings.
6. Close the drawer with its close button, the shaded page backdrop, or the Escape key.

Data-changing tools always require a read-only analysis followed by an explicit confirmation.

## Updating / removing

Your script manager will alert you when a newer version is available. Disable or delete the script
from the manager's dashboard at any time.

## License

MIT – do as you like; attribution appreciated.
