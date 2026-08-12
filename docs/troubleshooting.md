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
