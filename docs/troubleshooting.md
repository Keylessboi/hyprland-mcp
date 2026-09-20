# Troubleshooting

This document lists the failures you are most likely to meet. Each entry names the symptom, the cause, and the fix.

## The server answers "unknown request" to every call

**Symptom.** `get_state` fails. The error reads `non-JSON response for "..." : unknown request`.

**Cause.** The server wrote a trailing newline after the request. Hyprland's command socket rejects it. The real `hyprctl` client writes the raw string with no newline.

**Fix.** The bug was in `src/ipc.ts`, in the `connect` handler:

```ts
sock.write(command);       // correct
sock.write(command + '\n'); // wrong
```

Check that `rawRequest` writes the command as-is. The test harness now mirrors the newline-less request, so a regression fails CI.

## The server works in tests but not against the live desktop

**Symptom.** All tests pass. `hyprctl` works. The MCP server still fails.

**Cause.** A difference between the fake socket and the real one. The fake accepted anything. The real compositor parses strictly.

**Fix.** Test the raw protocol against the live socket before you trust the code:

```sh
python3 - <<'EOF'
import socket, glob
sock_path = glob.glob('/run/user/1000/hypr/*/.socket.sock')[0]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sock_path)
s.sendall(b'j/monitors')   # no newline
s.shutdown(socket.SHUT_WR)
print(s.recv(8192)[:200])
EOF
```

Expect JSON, not `unknown request`.

## The service runs an old binary

**Symptom.** A fix is in the source. The running server does not behave as fixed.

**Cause.** The systemd service runs the compiled binary at `dist/hyprland-mcp`. Source changes do not reach it until you rebuild.

**Fix.**

```sh
bun build src/index.ts --compile --outfile dist/hyprland-mcp
systemctl --user restart hyprland-mcp.service
```

Confirm the new binary is running:

```sh
systemctl --user status hyprland-mcp.service | grep "Main PID"
```

## The plugin will not load

**Symptom.** `hyprctl plugin load` fails. The log shows a version mismatch.

**Cause.** The plugin built against headers that differ from the running compositor. The version check refuses the load.

**Fix.** Rebuild against the current headers, or install through hyprpm, which pins the right commit:

```sh
hyprpm update
hyprpm enable hyprland-mcp-click
```

## The click lands in the wrong place

**Symptom.** `sendclick` returns `ok`. The click misses the window.

**Cause.** The coordinates were captured from a stale snapshot. The window moved between the snapshot and the click.

**Fix.** The server re-reads `clients` before it acts. If you call the plugin directly, take the window position from a fresh `hyprctl clients -j`, not from memory.

## The click path never uses the plugin

**Symptom.** `input_click` falls back to ydotool even though the plugin is loaded.

**Cause.** The probe runs once per process. A server started before the plugin loaded still has the old answer.

**Fix.** Restart the server process after loading the plugin:

```sh
systemctl --user restart hyprland-mcp.service
```

## The VM has no command socket

**Symptom.** Hyprland starts in the headless VM, then the socket never appears. The log shows a page-flip error.

**Cause.** A known issue with virtio DRM and software rendering.

**Fix.** Try the workarounds in order: restart Hyprland cleanly, set a fixed monitor mode, and as a last resort run the tests through `hyprctl` with an explicit `HYPRLAND_INSTANCE_SIGNATURE`. The full procedure is in `docs/test-vm.md`.

## Screenshots and input fail with SESSION_LOCKED

**Symptom.** `screenshot` and the input tools return `SESSION_LOCKED`. The error says the desktop is locked.

**Cause.** The screen is locked (hyprlock or another session lock). This is the server working as designed: while locked, the seat focus is the lock surface, so a click would land on the lock screen and typed text could enter the password field. The server refuses instead.

**Fix.** Unlock the screen, then retry. Read-only queries (`get_state`, `list_windows`) still work while locked.

**Why it fails closed.** If the server cannot confirm the session is unlocked (the `locked` query itself errors), it also refuses. Safer to refuse than to risk typing into a password field.

## Hyprland 0.56: `dispatch` is Lua now

0.56 removed the string dispatcher. The compositor evaluates a dispatch request
as `return hl.dispatch(<text>)`, so `dispatch movetoworkspacesilent name:agent,address:0x…`
dies with a Lua syntax error and a bare verb is rejected with
*"expected a dispatcher (e.g. hl.dsp.window.close())"*.

`src/ipc.ts` probes which dialect the compositor speaks once (by asking it to
focus an address that cannot exist) and translates each verb into the real
`hl.dsp.*` call.

**The dialect follows the config format, not the version.** A Debian 0.56.2
with a hyprlang `hyprland.conf` still answers the classic strings; an Arch
0.56.2 with a Lua `hyprland.lua` rejects them. Two machines on the same version
disagree, which is why the dialect is probed and never inferred.

**`hl.dsp.global` is not an escape hatch.** It is the dispatcher for *global
shortcuts*. Passing it a classic verb returns `ok` and does nothing — the worst
possible failure here, because a launch then lands on the user's screen with no
error to notice. Anything without a translation is refused with
`DISPATCH_UNSUPPORTED` instead.

The argument names that matter (from Hyprland's `LuaBindingsDispatchers.cpp`):

| classic | 0.56 Lua |
| --- | --- |
| `movetoworkspacesilent <ws>,<sel>` | `hl.dsp.window.move({ workspace = …, follow = false, window = … })` |
| `movetoworkspace <ws>,<sel>` | `hl.dsp.window.move({ workspace = …, window = … })` |
| `focuswindow <sel>` | `hl.dsp.focus({ window = … })` |
| `workspace <ws>` | `hl.dsp.focus({ workspace = … })` |
| `closewindow <sel>` | `hl.dsp.window.close({ window = … })` |
| `exec [workspace name:agent silent] cmd` | `hl.dsp.exec_cmd("cmd", { workspace = "name:agent silent" })` |
| `togglespecialworkspace <name>` | `hl.dsp.workspace.toggle_special("<name>")` |
| `movecursor <x> <y>` | `hl.dsp.cursor.move({ x = …, y = … })` |
| `sendshortcut "MODS, KEY, <sel>"` | `hl.dsp.send_shortcut({ mods = …, key = …, window = … })` |

There is **no `silent` key** — "silent" is spelled `follow = false`. There is no
`sendclick` dispatcher at all in 0.56 (it belongs to the optional click
plugin), so `input_click`'s overlay path is used instead.

Hyprland ships Lua type stubs at `/usr/share/hypr/stubs/hl.meta.lua`; they list
every `hl.dsp.*` name, though not the argument keys.

### Checking it against a real compositor

Unit tests cover the translation; two scripts check the compositor actually
obeys it. Both only ever touch a window they launched themselves, on their own
named workspace, and fail if the user's active workspace or windows moved.

```sh
node scripts/live-workspace-check.mjs ./dist/hyprland-mcp name:agent
node scripts/live-dispatch-check.mjs ./dist/hyprland-mcp
```

The geometry checks in the second script go through the lock guard, so they are
skipped (not failed) while the screen is locked.


## Classic dispatcher syntax that fails quietly

Verified against a real Hyprland 0.56.2 speaking the classic dialect. These
forms are all *wrong*, and two of the three are answered with `ok`:

| wrong | what happens | right |
| --- | --- | --- |
| `resizewindowpixel 640x480,<sel>` | **`ok`, resizes nothing** | `resizewindowpixel exact 640 480,<sel>` |
| `movewindowpixel 120,140,<sel>` | `moveWindow: no window` | `movewindowpixel exact 120 140,<sel>` |
| `movetoworkspacesilent <ws> <sel>` | `Invalid workspace` | `movetoworkspacesilent <ws>,<sel>` — one comma-joined argument |
| `movetoworkspacesilent agent,<sel>` | `Invalid workspace` | `movetoworkspacesilent name:agent,<sel>` |

Bare numbers in `movewindowpixel`/`resizewindowpixel` are a *delta*; `exact`
makes them absolute, which is what the `window` tool documents.

`fullscreen <mode> <sel>` cannot reach a window the compositor can't make
active, so a window parked on a hidden workspace returns `Window not found`.
The Lua dispatcher takes a real window selector and has no such limit.

## Checking against both dialects

The desktop you develop on probably speaks only one of the two. A vmhub
Hyprland VM covers the other:

```sh
# Debian's hyprland is 0.55; sid has 0.56.2, and its hyprlang config means it
# still speaks the classic strings.
echo 'deb http://deb.debian.org/debian sid main' > /etc/apt/sources.list.d/sid.list
printf 'Package: *\nPin: release a=unstable\nPin-Priority: 100\n' > /etc/apt/preferences.d/sid-pin
apt-get update && apt-get install -y -t unstable hyprland
```

Run the check as the session user **with its home as cwd** — `su` keeps the
caller's cwd, and a terminal whose cwd is an unreadable `/root` dies instantly
with `slave exited with signal 1`, which looks exactly like a compositor bug.
