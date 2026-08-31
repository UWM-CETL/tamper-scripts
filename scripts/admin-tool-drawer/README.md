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

The icon is only added when the current Canvas user can view at least one account through Canvas's
Accounts API. Canvas normally returns an empty account list for students and teachers. The result is
cached in the current browser tab for 15 minutes so normal Canvas navigation does not repeat the
check on every page load.

## Installation

[Install this script](https://uwm-cetl.github.io/tamper-scripts/scripts/admin-tool-drawer/admin-tool-drawer.user.js)

## Using it

1. Sign in to a Canvas site hosted on `instructure.com` with an account-admin role.
2. Select the tools icon in the upper-right corner.
3. Confirm or enter the Canvas ID in the relevant Admin, Course, or Page accordion.
4. Close the drawer with its close button, the shaded page backdrop, or the Escape key.

The drawer currently contains no data-changing tools.

## Updating / removing

Your script manager will alert you when a newer version is available. Disable or delete the script
from the manager's dashboard at any time.

## License

MIT – do as you like; attribution appreciated.
