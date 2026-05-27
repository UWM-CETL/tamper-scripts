
# README for `admin-remove-subaccount-roles.user.js`

## What it does
Adds an **"Remove admin access"** button to every User Admin page when the user is enrolled in 
subaccounts. If an admin with necessary rights clicks the button, all the admin roles under
a specific subaccount are removed. A log is generated aftewards for auditing purposes.

## Installation
[Install this script](https://uwm-cetl.github.io/tamper-scripts/scripts/admin-remove-subaccount-roles/admin-remove-subaccount-roles.user.js)

## Using it
* Visit the top-most subaccount available as a role with Account role add/remove access.
* Click the button
* Acknowledge the action.

When the process is complete, a log will be automatically downloaded for auditing and recordkeeping.

**Important Note:** the script traverses subaccounts under the _current_ subaccount. For example,
if an admin uses this script on a user page in account 1, admin access will be removed from account 1 and all subaccounts. From subaccount 49, any role removals happen in 49 and all child subaccounts. The
removal does not traverse federated subaccounts.

## Updating / removing

Your script manager will alert you when a newer version is available.
Disable or delete the script from the manager’s dashboard at any time.

## License

MIT – do as you like; attribution appreciated.
