# hyprland-mcp

An MCP server for Hyprland desktop control. An AI agent uses it to see your desktop and act on it. The agent can test an app in the background without taking over your screen.

## What it does

The server gives an agent these tools:

- **See the desktop.** List every window, including windows on other workspaces. Capture any window, even one that is occluded or hidden. The capture does not disturb the app.
- **Type and click.** Send text, key chords, mouse clicks, and clipboard paste. The click path uses a native plugin when it is loaded (see below). Screenshots and input are refused while the screen is locked (`SESSION_LOCKED`); read-only queries still answer.
- **Launch and control.** Start apps, move them to a private agent workspace, focus, close.
- **See what the app did.** Every launch records the app's pid, stdout/stderr and exit code. `app_status` returns them, so an agent catches crashes and log output a window never shows. `launch` itself fails fast, with the output tail, when the app exits before opening a window.

## The agent workspace

The agent works on its own workspace. You work on yours. The agent reads windows, takes screenshots, and sends input to its workspace. Your view never changes.

Launch an app into the agent workspace in one step (the named workspace is created on demand):

```
launch { command: "foot", args: ["--title", "agent-shell"], workspace: "name:agent", wait_for_window: true }
→ { launch_id: "l-…", pid: 12345, window: "0x…" }
app_status { launch_id: "l-…" }
→ { running: true, exit_code: null, output: "…stdout+stderr tail…" }
```

Launch records live in `$XDG_RUNTIME_DIR/hyprland-mcp/launches/<launch_id>/` (`pid`, `out`, `exit`), private to the user. Set `HYPRLAND_MCP_LAUNCH_DIR` to move them.

The agent sees the window wherever it sits. No focus change. No workspace switch.

## The click plugin

The server can click any window through the [hyprland-mcp-click](https://github.com/Keylessboi/hyprland-mcp-click) plugin. The plugin adds a `sendclick` dispatcher. One dispatch clicks a window, even a hidden one, with no flash. The server uses it when the plugin is loaded and falls back to its old path otherwise.

Install the plugin:

```sh
hyprpm add https://github.com/Keylessboi/hyprland-mcp-click
hyprpm enable hyprland-mcp-click
```

## Requirements

- Hyprland 0.41+
- Node 20+
- grim, wtype, wl-clipboard (for text input and screenshots)
- ydotoold (only for the fallback click path)

## Install

```sh
git clone https://github.com/Keylessboi/hyprland-mcp.git
cd hyprland-mcp
npm install
```

## Build and install

```sh
bun install
bun run build                                  # dist/hyprland-mcp (single binary)
install -m 0755 dist/hyprland-mcp ~/.local/bin/hyprland-mcp
```

It is a stdio server: the agent starts it. There is no daemon to run.

## Wire into agents

Claude Code (user scope):

```sh
claude mcp add -s user hyprland -- ~/.local/bin/hyprland-mcp
```

opencode (`~/.config/opencode/opencode.json`):

```jsonc
"mcp": {
  "hyprland": {
    "type": "local",
    "command": ["/home/<you>/.local/bin/hyprland-mcp"],
    "timeout": 10000
  }
}
```

For VMs instead of this desktop, use [vmhub](https://github.com/Keylessboi/vmhub): its Hyprland golden runs this server inside the VM.

## Run tests

```sh
npm install
npx vitest run          # deterministic tests; no live compositor needed
npx tsc --noEmit        # typecheck
```

The tests use a fake Hyprland socket. They never touch the live desktop.

## Text-only models and screenshots

The `screenshot` tool returns an image plus a coordinate mapping. A vision-capable model sees the image inline. A text-only model gets the coordinates.

The tool also writes every capture to a file under `~/Pictures/hyprland-mcp/` and returns that absolute path in the `file` field. A text-only model hands the path to a **vision subagent**, which reads the file and describes what it shows.

If your model cannot see images (for example `deepseek-v4-flash`), it MUST route screenshots through the **vision skill** to learn what is on screen. The skill sends the image (by file path) to a vision-capable model and returns a JSON description. Never let a text-only model guess what a screenshot shows. The directory is private (`0700`).

## VM testing

A KVM VM runs Hyprland for live smoke tests. The full setup guide is in `docs/test-vm.md`.

## Docs

- `docs/architecture.md` — how the server works
- `docs/plugin.md` — the click plugin integration
- `docs/troubleshooting.md` — common failures and fixes
- `docs/test-vm.md` — VM setup

## Skills

Two agent skills ship in this repo and sync to the local opencode collection:

- `skills/hyprland-agent-workspace` — work on a dedicated named workspace so the user's screen stays untouched. Launch with `workspace: "name:agent"`, verify placement, clean up.
- `skills/hyprland-tester` — the desktop test loop: capture, vision-analyze, act, verify.

The repo is the canonical source. After changing a skill, reinstall it locally:

```sh
./scripts/sync-skills.sh
```

## License

MIT
