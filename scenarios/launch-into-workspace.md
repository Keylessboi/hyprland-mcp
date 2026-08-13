# Scenario: Launch Into a Named Workspace

**ID:** LAUNCH-01
**Source:** User requirement — launch apps on a dedicated workspace, never the user's current one. Live finding: a negative numeric id (-42) is a dead zone in Hyprland; a `name:` selector resolves to a -1337-class id and is created on demand.

## Given
- The MCP server is connected to a compositor.
- The launch tool's `workspace` parameter accepts a number or a Hyprland selector string.

## When
- The agent calls `launch` with `workspace: "name:agent"` and an app command.

## Then
- The server dispatches exactly one `exec` with the rule `[workspace name:agent]` prefixed.
- The command argv is quote-joined so a space in an arg survives the shell.
- With `wait_for_window: true`, the server polls for a window whose class matches AND whose workspace id equals the resolved named workspace id (a -1337-class value), not the current workspace.
- With `wait_for_window: false`, the server returns the workspace selector and does not poll.

## And (numeric id form)
- `launch` with `workspace: 5` dispatches `exec [workspace 5] ...` and matches a window on workspace id 5.

## And (no workspace)
- `launch` without `workspace` performs no `exec` dispatch (current behavior unchanged).

## Notes
The live behavior (window lands on the named workspace, never the current one) is a smoke-test oracle run in the VM. The deterministic contract here covers the dispatch format, the selector resolution, and the poll matching.
