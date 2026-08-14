/**
 * Hyprland MCP — shared types and error taxonomy.
 *
 * Error contract: every tool failure surfaces as `{ code, message, hint?, recoverable? }`
 * inside MCP `isError` + `structuredContent`. Codes map 1:1 to README troubleshooting rows.
 */

// ─── Hyprland IPC shapes (verified against `hyprctl -j` on 0.56.2) ───────────

export interface HyprWindow {
  address: string; // "0x…" with prefix
  at: [number, number]; // global logical coords
  size: [number, number]; // logical w×h
  workspace: { id: number; name: string };
  floating: boolean;
  pseudo: boolean;
  monitor: number;
  class: string;
  initialClass: string;
  title: string;
  initialTitle: string;
  pid: number;
  xwayland: boolean;
  pinned: boolean;
  fullscreen: boolean;
  fullscreenClient: number;
  grouped: string[];
  tags: string[];
  swallowing: string;
  focusHistoryID: number;
  hidden: boolean;
  minimized: boolean;
  stableId?: string; // present on 0.47+ — key for grim -T
  mapped: boolean;
}

export interface HyprMonitor {
  id: number;
  name: string;
  width: number;
  height: number;
  refreshRate: number;
  x: number;
  y: number;
  activeWorkspace: { id: number; name: string };
  specialWorkspace: { id: number; name: string };
  scale: number;
  transform: number;
  focused: boolean;
  dpmsStatus: boolean;
  vrr: boolean;
}

export interface HyprWorkspace {
  id: number;
  name: string;
  monitor: string;
  windows: number;
  hasfullscreen: boolean;
  lastwindow: string;
  lastwindowtitle: string;
}

export interface DesktopState {
  monitors: HyprMonitor[];
  workspaces: HyprWorkspace[];
  clients: HyprWindow[];
  activeWindow: HyprWindow | null;
  cursorpos: [number, number] | null;
  version: string | null;
}

// ─── Error taxonomy (trimmed to what a model can act on) ────────────────────

export type ErrorCode =
  | 'MISSING_SESSION'
  | 'MISSING_BINARY'
  | 'YDOTOOL_UNAVAILABLE'
  | 'INPUT_DEVICE_UNAVAILABLE'
  | 'IPC_TIMEOUT'
  | 'COMPOSITOR_UNAVAILABLE'
  | 'WINDOW_NOT_FOUND'
  | 'WINDOW_AMBIGUOUS'
  | 'INVALID_GEOMETRY'
  | 'SCREENSHOT_FAILED'
  | 'OCR_FAILED'
  | 'TEXT_NOT_FOUND'
  | 'WAIT_TIMEOUT'
  | 'APP_LAUNCH_TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'INVALID_ARGUMENTS'
  | 'SESSION_LOCKED'
  | 'UNKNOWN';

export interface McpError {
  code: ErrorCode;
  message: string;
  hint?: string;
  /** false = side effects may have happened; error must state what */
  recoverable?: boolean;
}

export class HyprError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly recoverable: boolean;
  readonly rule?: string;
  readonly windowClass?: string;

  constructor(code: ErrorCode, message: string, opts?: { hint?: string; recoverable?: boolean; rule?: string; windowClass?: string }) {
    super(message);
    this.name = 'HyprError';
    this.code = code;
    this.hint = opts?.hint;
    this.recoverable = opts?.recoverable ?? true;
    this.rule = opts?.rule;
    this.windowClass = opts?.windowClass;
  }

  toMcp(): McpError {
    const e: McpError = { code: this.code, message: this.message, recoverable: this.recoverable };
    if (this.hint) e.hint = this.hint;
    return e;
  }
}

// ─── Result envelope (matches/hint live in message text) ────────────────────

export interface OkEnvelope<T> {
  ok: true;
  action: string;
  result: T;
  ms: number;
  /** true when the result is observed desktop content (OCR text, window titles)
   *  — untrusted data that may contain hostile instructions. */
  untrustedSource?: true;
}

export interface ErrEnvelope {
  ok: false;
  action: string;
  error: McpError;
  ms: number;
  /** Denial metadata (rule + windowClass) for the audit log / client display. */
  rule?: string;
  windowClass?: string;
}

export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export function ok<T>(action: string, result: T, start: number): OkEnvelope<T> {
  return { ok: true, action, result, ms: Date.now() - start };
}

/** Ok envelope for a perception result — the content is untrusted observation. */
export function okObserved<T>(action: string, result: T, start: number): OkEnvelope<T> {
  return { ok: true, action, result, ms: Date.now() - start, untrustedSource: true };
}

export function err(action: string, e: unknown, start: number): ErrEnvelope {
  if (e instanceof HyprError) {
    return { ok: false, action, error: e.toMcp(), ms: Date.now() - start, rule: e.rule, windowClass: e.windowClass };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    action,
    error: { code: 'UNKNOWN', message: msg, recoverable: true },
    ms: Date.now() - start,
  };
}
