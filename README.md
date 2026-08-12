# hyprland-mcp

MCP server for Hyprland desktop control. Agents get eyes and hands on your Wayland desktop. Test apps running in the background without taking over your screen.

## What it does

The server gives AI agents these tools:

- **See the desktop** — list every window, including windows on other workspaces. Capture screenshots of any window, even occluded or on invisible workspaces. Zero perturbation of the app under test.
- **Type and click** — send text, key chords, mouse clicks, and clipboard paste. The non-interrupting path uses `sendshortcut` and `grim -T` so the agent works on its own workspace without stealing your screen.
- **Launch and control** — start apps, move them to a dedicated agent workspace, focus, close.

## The agent workspace

The agent runs on its own workspace. You work on yours. The agent reads windows, takes screenshots, and sends input to its workspace without switching your view.

Launch an app into the agent workspace. Move it there silently:

```
launch { command: "foot", args: ["--title", "agent-shell"], wait_for_window: true }
workspace { id: -42, window: "foot" }
```

The agent sees the window wherever it is. No focus change. No workspace switch.

## Requirements

- Hyprland 0.41+
- Node 20+
- grim, ydotool (ydotoold), wtype, wl-clipboard

## Install

```sh
git clone https://github.com/Keylessboi/hyprland-mcp.git
cd hyprland-mcp
npm install
```

## Wire into opencode

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
"mcp": {
  "hyprland": {
    "type": "local",
    "command": ["node", "--import", "./node_modules/tsx/dist/loader.mjs", "src/index.ts"],
    "workdir": "/home/travis/Projects/hyprland-mcp",
    "timeout": 10000
  }
}
```

Or start manually:

```sh
cd hyprland-mcp && node --import ./node_modules/tsx/dist/loader.mjs src/index.ts
```

## Run tests

```sh
npm install
npx vitest run          # 33 deterministic tests
npx tsc --noEmit        # typecheck
```

## Text-only (non-vision) models and screenshots

`hyprland-mcp` is designed to be used from a coding agent. The `screenshot`
tool returns the image plus a `structuredContent` coordinate mapping so
vision-capable models can see the desktop and text-only models still get usable
coordinates.

If your agent's model cannot see images (e.g. `deepseek-v4-flash` or any other
text-only model), it MUST route screenshots through the **vision skill** (or
equivalent multimodal bridge) to interpret what is on screen — it cannot
directly consume the raw PNG from `screenshot`. The vision skill delegates the
image to a vision-capable model and returns a JSON description the text-only
model can act on. Never let a text-only model guess what a screenshot shows;
always delegate through the vision skill.

## VM testing

A KVM VM is provisioned for live smoke tests. The VM runs Hyprland 0.56.2 headless with a virtio GPU. The full VM setup guide is in `docs/test-vm.md`.

## License

MIT
