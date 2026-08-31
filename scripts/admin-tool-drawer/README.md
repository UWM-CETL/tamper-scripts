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
operate on courses. A grouped, multiple-selection **Terms** scope provides flexible meta-options for
**All Current Terms** and **All Terms**, followed by the Canvas **Default Term** and individual
**Current Terms**, **Future Terms**, **Past Terms**, and **Undated Terms**. All Current Terms is the
safe default and can be combined with individual terms from the other groups.

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

## Installation

[Install this script](https://uwm-cetl.github.io/tamper-scripts/scripts/admin-tool-drawer/admin-tool-drawer.user.js)

## Using it

1. Sign in to a Canvas site hosted on `instructure.com` with an account-admin role.
2. Select the tools icon in the upper-right corner.
3. Confirm or enter the Canvas ID in the relevant Admin, Course, or Page accordion.
4. For the navigation report, open **Admin → Courses**, select the term scope and whether to limit the
   scope to published courses, and select **Get all navigation links**.
5. Close the drawer with its close button, the shaded page backdrop, or the Escape key.

The drawer currently contains no data-changing tools.

## Updating / removing

Your script manager will alert you when a newer version is available. Disable or delete the script
from the manager's dashboard at any time.

## License

MIT – do as you like; attribution appreciated.
