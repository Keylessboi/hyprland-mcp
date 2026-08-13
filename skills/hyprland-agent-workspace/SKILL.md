---
name: hyprland-agent-workspace
description: Work in a dedicated Hyprland workspace so the user's screen stays untouched. Launch apps into a named agent workspace with the hyprland-mcp server, verify they landed there, and clean up when done. Use when asked to test an app, launch a program, run a visual check, or drive the desktop without interrupting the user. Triggers: "launch this", "test the app", "work in the background", "don't touch my screen", "open it on another workspace".
---

# Hyprland Agent Workspace

Run your app work on your own Hyprland workspace. The user keeps their screen. You keep yours. Nothing you do appears on their display.

## The rule

Never launch into the user's active workspace. Launch into a dedicated named workspace. Hyprland creates it on demand and it never shows on the user's screen.

## Launch into a workspace

Use the `launch` tool with the `workspace` parameter. This is the one-step, verified path — no separate move call:

```
launch { command: "foot", args: ["--title", "agent-shell"], workspace: "name:agent", wait_for_window: true }
```

The `workspace` value is a Hyprland selector:

| Value | Result |
|---|---|
| `name:agent` | Creates a named workspace on demand (id -1337 class). Preferred for agent work. |
| `name:<anything>` | Any named workspace, created on demand. |
| `5` | A numeric workspace id. Must already exist or be created by Hyprland. |

Do not use a made-up negative number like `-42` — it is a dead zone in Hyprland and the launch silently falls back to the current workspace. Use `name:` for a named workspace, or a positive id for a numbered one.

## Verify placement

After `wait_for_window: true`, the tool returns the window address. Confirm it landed on the agent workspace, not the user's:

```
get_state  →  find the window, check its "workspace" field
```

The window must report workspace `-1337` (name `agent`), or whatever named workspace you chose. If it reports the user's workspace id, the launch went wrong — close it and relaunch with `name:`.

## Work there

Screenshot, click, type — all with `target` set to the window:

```
screenshot { target: "window", window: "foot" }
input_click { target: "foot" }
input_paste { text: "input", target: "foot" }
```

The MCP server handles hidden-window capture and clicks. The user never sees any of it.

## Clean up

When done, close the app and leave the workspace empty:

```
close { target: "foot" }
```

The empty named workspace is harmless. Hyprland removes it per config. Do not switch the user's active workspace to clean up — leave their view exactly as you found it.

## Do not

- Do not switch the user's active workspace.
- Do not steal focus from the user's windows.
- Do not launch into the current workspace and move afterward — use the one-step `workspace:` parameter.
- Do not run `grim`, `hyprctl`, `ydotool`, or `wtype` yourself — the MCP server owns the desktop. Use its tools.

## Failure handling

| Symptom | Action |
|---|---|
| `APP_LAUNCH_TIMEOUT` | The app did not open in time. Check `get_state` for the window, then retry. |
| Window on the wrong workspace | Close it. Relaunch with `workspace: "name:agent"`. |
| `WINDOW_NOT_FOUND` | The app closed or never opened. Restart it. |
| `MISSING_SESSION` | Hyprland is not running. Tell the user. |
| Only if a task explicitly requires the user's workspace | Touch it, then restore focus and the workspace afterward. |
