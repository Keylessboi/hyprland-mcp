# Scenario: IPC Freeze Contract

**ID:** IPC-01
**Source:** Plan §2 (adversary R5 + deep, verified against Hyprland wiki)

## Given
- A Hyprland instance socket exists at a known path.

## When
- The server sends a `j/monitors` request.

## Then
- The server opens a connection, writes the request, reads to EOF, and closes it.
- Each request uses a fresh connection (never reused).
- Concurrent requests are serialized (never parallel on socket1).
- A request that exceeds the 3s timeout fails with `IPC_TIMEOUT`.
- A request to a missing socket fails with `COMPOSITOR_UNAVAILABLE`.

## Notes
The 5-second compositor freeze on unclosed connections is the motivating
risk; this test proves the contract that prevents it.
