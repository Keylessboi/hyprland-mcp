# Architecture

This document explains how the server works. Read it before you change the code.

## The shape

The server is a TypeScript program that speaks the MCP protocol over stdio. Each tool call talks to Hyprland through its IPC socket. The parts:

- `ipc.ts` — the socket client
- `events.ts` — the event stream
- `discovery.ts` — finding the Hyprland instance
- `state.ts` — the desktop snapshot
- `geometry.ts` — coordinate math
- `screenshot.ts` — window capture
- `input.ts` — text and button input
- `security.ts` — the capability gate
- `tools/core.ts` — the MCP tools

## The IPC contract

Hyprland exposes two sockets per instance.

- `.socket.sock` — one request, one response.
- `.socket2.sock` — a stream of events.

The command socket is the strict part. An unclosed connection freezes Hyprland for 5 seconds. The server avoids that with four rules:

1. One connection per request. The server never reuses a connection.
2. A request is a single write, then a read to EOF.
3. All requests run through one mutex. Two requests never touch the socket at once.
4. A request has a hard timeout.

The request has no trailing newline. The real `hyprctl` client writes the raw string. A newline makes Hyprland answer `unknown request`. The test harness mirrors this, so the bug cannot return.

Hyprland answers the request, then closes the connection. The server reads until the socket ends. That is the whole response.

## Discovery

The server finds Hyprland on its own. It scans `/run/user/$UID/hypr/*/` for an instance directory, then checks the socket by asking for `monitors`. The instance signature can also come from the environment or the config. Discovery runs again on every reconnect.

## The state model

The server keeps a snapshot of the desktop: monitors, workspaces, windows, the focused window, and the cursor. The snapshot is a cache, not a source of truth.

Hyprland sends no geometry events. A window can move and the cache will not know. So the server re-reads `clients` before every act. After a mutating call it polls until the expected state appears. This rule keeps the cache honest.

## The freeze contract

The compositor freezes for 5 seconds if a client leaves a connection open. The freeze contract is the set of rules that prevents it. The tests assert the contract: one connection per request, serialized, closed on response. A regression here is the worst possible bug class, because it freezes the user's desktop.

## Coordinates

The server uses one space: global logical coordinates. `hyprctl` reports positions and sizes in this space. The cursor moves in this space. A screenshot captures this space.

A capture returns physical pixels. The scale lookup maps them back. A screenshot carries both the image and the mapping, so a text-only model still gets usable coordinates.

## Input

Text goes through `wtype` for ASCII. Unicode goes through `wl-copy` plus a paste chord. Buttons go through the `sendclick` plugin when it is loaded. Without the plugin, the server moves the cursor and clicks with ydotool.

Input is the riskiest part. The server verifies the focused window before it sends anything. The fallback path runs its overlay sequence and restores the workspace afterward.

## Tools

The tools fall into three groups.

- **Orient.** `get_state`, `list_windows`, `get_window`.
- **Act.** `launch`, `focus`, `close`, `kill`, `workspace`, `configure`.
- **Input.** `input_type`, `input_key`, `input_click`, `input_drag`, `input_paste`.
- **Sight.** `screenshot`, `wait_window`.

Windows are addressed by address, class, or title. The server resolves a selector to exactly one window. An ambiguous selector is an error, never a silent first match.

## The security boundary

The server runs over stdio. The opencode session is the auth boundary. Two rules hold it closed:

- **No implicit execution.** Window titles and URLs are data. The server never runs them as commands.
- **Exec is gated.** `launch` is the only exec path, and it checks the capability config first.

Screenshots land in a private directory with a short lifetime. Clipboard reads are gated because they may hold secrets.

## The lock guard

A locked screen is an input hazard. Under hyprlock the seat focus is the lock surface, so a click lands on the lock screen and typed text can enter the password field.

The server asks the compositor for its own lock state (`hyprctl locked`, from the session-lock manager) before every screenshot and every input tool. Locked means refusal: the tool returns `SESSION_LOCKED`. The check fails closed — if the query itself errors, the server also refuses, because it cannot confirm the session is safe.

Read-only queries (`get_state`, `list_windows`) still answer while locked. Only capture and input are gated.

## Error contract

Every tool returns `{ ok, error, hint, recoverable }` on failure. The common failure is silent wrongness: a black screenshot, a stale window, a click 40 pixels off. The server checks for these signs where it can and reports them instead of returning a false success.
