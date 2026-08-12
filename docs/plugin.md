# Plugin integration

The [hyprland-mcp-click](https://github.com/Keylessboi/hyprland-mcp-click) plugin gives the server a fast, safe way to click windows. This document explains how the two connect.

## Why the plugin

The server's fallback click path works. It moves the cursor, clicks with ydotool, and for hidden windows it runs an overlay sequence in TypeScript. The sequence takes several IPC roundtrips and a sleep. Between roundtrips, Hyprland can draw a frame. The window can flash on screen.

The plugin does the same work in one native dispatch. The whole sequence runs inside one Hyprland event turn. No frame can draw in the middle. The click is atomic and invisible.

## How the server decides

The server probes for the plugin once per process. It asks `hyprctl plugin list` and looks for `hyprland-mcp-click`. The result is cached in a `WeakMap` keyed by the IPC client. A fresh server process probes again.

The tool `input_click` takes this path when three things are true:

1. The caller named a target window.
2. The caller did not set `via_overlay: false`.
3. The plugin probe returned true.

Otherwise the server uses the fallback path.

## What the server sends

The server builds one dispatch:

```ts
await ipc.dispatch(['sendclick', `address:${address},button:${button}`]);
```

The plugin finds the window by its address and clicks its center. The button is one of `left`, `right`, `middle`.

The server records where the window was after the call, for the tool response. It does not track the overlay state: the plugin restores the window itself.

## The probe

The probe lives in `src/tools/core.ts`:

```ts
async function probeSendclick(ipc) {
  const list = await ipc.request('plugin list');
  return list.includes('hyprland-mcp-click');
}
```

A failed probe (no compositor, plugin missing) returns false and the server keeps its old path. The probe never throws out of the tool.

## The fallback path

Without the plugin, `input_click` keeps the old behavior:

- A visible window: move the cursor, click with ydotool.
- A hidden window: move it to a special workspace, show it, focus it, click, hide it, move it back.

The fallback still restores the workspace. It is slower and can flash, but it works without the plugin.

## Tests

The test suite covers both paths. `tests/mcp.test.ts` has two cases:

- With `hyprland-mcp-click` in the fake `plugin list`, the tool makes one `sendclick` dispatch and no ydotool call.
- Without it, the tool makes no `sendclick` dispatch and does call ydotool.

The fake socket records every request, so the tests assert the exact call pattern.

## Keeping them in step

The plugin pins itself to a Hyprland version through `hyprpm.toml`. Its auto-update CI adds a pin and a release for each new Hyprland version. The server does not pin the plugin. Any loaded version that answers `sendclick` works.

If the plugin is missing or outdated, the server falls back. That is the safety property: the server never depends on the plugin being present.
