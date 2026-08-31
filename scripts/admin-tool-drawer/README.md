# Canvas Admin Tool Drawer

## What it does

Adds a warning-styled admin tools icon to the upper-right corner of Canvas. Selecting the icon opens
an accessible drawer from the left side of the page. The drawer is a shell for admin workflows that
will be added over time.

The icon is only added when the current Canvas user can view at least one account through Canvas's
Accounts API. Canvas normally returns an empty account list for students and teachers. The result is
cached in the current browser tab for 15 minutes so normal Canvas navigation does not repeat the
check on every page load.

## Installation

[Install this script](https://uwm-cetl.github.io/tamper-scripts/scripts/admin-tool-drawer/admin-tool-drawer.user.js)

## Using it

1. Sign in to a Canvas site hosted on `instructure.com` with an account-admin role.
2. Select the warning icon in the upper-right corner.
3. Close the drawer with its close button, the shaded page backdrop, or the Escape key.

The drawer currently contains no data-changing tools.

## Updating / removing

Your script manager will alert you when a newer version is available. Disable or delete the script
from the manager's dashboard at any time.

## License

MIT – do as you like; attribution appreciated.
