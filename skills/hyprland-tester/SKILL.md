---
name: hyprland-tester
description: Automated desktop UI testing through the Hyprland MCP server. Captures screenshots, analyzes them via the vision skill, clicks and types, and re-verifies. Use when asked to test a desktop app, verify UI behavior, run a visual regression check, or drive a background app without interrupting the user. Triggers: "test the UI", "verify the app", "check the window", "click the button in", "type into and verify".
---

# Hyprland Desktop Tester

Test desktop apps through the Hyprland MCP server. The agent drives the app in a dedicated workspace. The user never sees it. Screenshots go to the vision skill. Analysis drives the next action. Repeat until the test condition is met or fails.

## Preflight

The Hyprland MCP server must be registered in opencode. Verify it is reachable:

```
health  →  { version: "Hyprland 0.56.2", capabilities: {...} }
```

If the server is not reachable, run:

```sh
systemctl --user start hyprland-mcp
```

## Agent Workspace Setup

The agent tests in its own space. Launch the app directly onto a dedicated named workspace so the user's screen stays untouched. This is the one-step path — no separate move call. For the full workspace workflow, load the `hyprland-agent-workspace` skill.

```
launch { command: "foot", args: ["--title", "test-terminal"], workspace: "name:agent", wait_for_window: true }
```

`get_state` confirms the placement — the window reports workspace `-1337` (name `agent`), never the user's workspace id.

## Test Loop

Four steps. Repeat until done.

### 1. Capture

Take a screenshot of the test window. The window does not need to be visible:

```
screenshot { target: "window", window: "foot" }
```

The response includes an image. The image content block goes to the vision step.

If the window is on a non-active workspace, `grim -T` captures its surface natively. Zero perturbation.

### 2. Analyze

**Use the vision skill. Never call a vision model directly.**

Load the vision skill and delegate with a focused question:

```
skill(name="vision")
```

The vision subagent receives the screenshot. Ask a narrow question: "Is the Save button visible?" "What text appears in the header?" "Did the error dialog appear?" The subagent answers in JSON.

Keep each visual question small. One question per delegation. Chain questions only when the first answer drives the second.

### 3. Act

Based on the vision result, take an action through the MCP server:

- Click a button: the `input_click` tool handles background-window clicks automatically. It uses the special workspace overlay to make the window visible for the duration of the click, then hides it. The user never sees it.

```
input_click { target: "foot" }
```

This clicks the center of the window. For a specific coordinate, pass `x` and `y`:

```
input_click { x: 340, y: 220, target: "foot" }
```

- Type text: `input_paste` copies to the clipboard and sends Ctrl+V via `sendshortcut`. Zero focus change.

```
input_paste { text: "test input string", target: "foot" }
```

- Press a key chord: `input_key` with `target` uses `sendshortcut` (no focus steal).

```
input_key { chord: "enter", target: "foot", mods: [] }
```

- Read clipboard state: `clipboard_read` reads whatever is on the clipboard.

### 4. Verify

Screenshot again, delegate to vision, compare. The vision subagent should say whether the expected change happened.

## Loop Control

Stop after:
- The vision subagent confirms the expected result
- Three consecutive actions produce no visible change
- The test budget (actions or wall time) is exhausted

Report the result: what was tested, what actions were taken, what the final screenshot shows.

## Failure Handling

| Symptom | Action |
|---|---|
| MCP server unreachable | Start the service, wait 3s, retry once |
| `WINDOW_NOT_FOUND` | The app may have closed. Restart or report. |
| `APP_LAUNCH_TIMEOUT` | The app did not open in time. Report the pid. |
| `YDOTOOL_UNAVAILABLE` | ydotoold is down. Notify the user to start it. |
| Vision subagent returns uncertain | Capture a higher-resolution screenshot and retry once. |
| Three consecutive actions with no visual change | Stop the loop. The app may be unresponsive. |
| `MISSING_SESSION` | Hyprland is not running. Tell the user. |

## Workspace Cleanup

After testing, close the test window. Do not switch the user's active workspace:

```
close { target: "foot" }
```

The empty named workspace is harmless. Hyprland removes it per config.

## Example: Verify a Terminal Prompt

Goal: check that kitty shows "user@host:~$" after launch.

```
launch { command: "kitty", workspace: "name:agent", wait_for_window: true }
screenshot { target: "window", window: "kitty" }
```

Delegate to the vision skill: "Read the terminal prompt. What text is on the last line?"

If the vision subagent reports "user@host:~$", the test passes. If it reports something else or is uncertain, fall back to `input_paste` + Enter with a known command, then screenshot again.
