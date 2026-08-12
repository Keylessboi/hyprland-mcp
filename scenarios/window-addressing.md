# Scenario: Window Addressing

**ID:** WIN-01
**Source:** Plan §8 (deep 2b, scout A4)

## Given
- The desktop has windows: `chromium` ("Omi AI"), `gajim` ("Gajim"), `kitty` ("Terminal"), and `chromium` helper (2 chromium windows).

## When
- The server resolves a selector.

## Then
- An exact `address` matches exactly one window.
- A `class` matching exactly one window resolves to it.
- A substring matching multiple windows (`chromium`) FAILS with `WINDOW_AMBIGUOUS` — never silently first-match.
- A selector matching nothing fails with `WINDOW_NOT_FOUND`.

## Notes
Ambiguity must error, not guess — silent first-match is an input-misdirection engine.
