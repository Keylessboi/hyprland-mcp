/**
 * IPC — native Hyprland command-socket client.
 *
 * THE FREEZE CONTRACT (adversary R5, verified): `.socket.sock` is evaluated
 * 100% synchronously by the compositor; an unclosed connection freezes
 * Hyprland for 5 seconds. Therefore:
 *   - connect → write request → read-to-EOF → close, PER REQUEST
 *   - all requests serialized behind one mutex (single-connection semantics)
 *   - hard timeout on every read; connection object never reused
 *   - no persistent socket1, no parallel requests
 */
import net from 'node:net';
import { HyprError } from './types.js';

const DEFAULT_TIMEOUT_MS = 3000;

export interface HyprlandConfig {
  /** Path to the instance socket dir, e.g. /run/user/1000/hypr/<SIG> */
  socketDir: string;
  timeoutMs?: number;
}

export function socketPath(cfg: HyprlandConfig): string {
  return `${cfg.socketDir}/.socket.sock`;
}

/**
 * Single connect-write-read-close round trip.
 * Returns the raw response text. `ok:false` string is never thrown — the
 * caller decides; dispatch errors surface as text from the compositor.
 */
export function rawRequest(cfg: HyprlandConfig, command: string): Promise<string> {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<string>((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath(cfg) });
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new HyprError('IPC_TIMEOUT', `hyprctl request timed out after ${timeoutMs}ms: ${command.slice(0, 60)}`, { recoverable: true }));
    }, timeoutMs);

    sock.setNoDelay(true);
    sock.on('connect', () => {
      // hyprctl writes the raw request with NO trailing newline; the compositor
      // responds then closes the connection (single request per connection).
      sock.write(command);
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(buf);
    });
    sock.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new HyprError('COMPOSITOR_UNAVAILABLE', `cannot connect to Hyprland socket: ${e.message}`, {
        hint: 'Is Hyprland running? Check HYPRLAND_INSTANCE_SIGNATURE and the instance socket dir.',
      }));
    });
  });
}

/** JSON request (`j/...` prefix) → parsed value. */
export async function jsonRequest<T>(cfg: HyprlandConfig, command: string): Promise<T> {
  const raw = await rawRequest(cfg, `j/${command}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HyprError('COMPOSITOR_UNAVAILABLE', `non-JSON response for "${command}": ${raw.slice(0, 120)}`, {
      hint: 'Version drift? The server may be speaking to a different Hyprland than expected.',
    });
  }
}

/**
 * Hyprland 0.56 replaced the plain `dispatch <verb> <args>` string with a Lua
 * API: the compositor evaluates the request as `return hl.dispatch(<text>)`,
 * so the old form dies with "')' expected near 'foot'" and even a bare verb is
 * rejected ("expected a dispatcher (e.g. hl.dsp.window.close())").
 *
 * `hl.dsp.global(...)` looks like a general escape hatch and is not one — it is
 * the dispatcher for *global shortcuts*, so it answers `ok` and does nothing
 * for every classic verb. Silent success is the worst possible failure for a
 * server whose whole job is keeping windows off the user's screen, so each
 * verb is translated into the real `hl.dsp.*` call instead, and anything with
 * no translation is refused loudly.
 *
 * Which form the compositor wants is discovered once, from its own answer, so
 * the server works on both without a version table.
 */
export type DispatchDialect = 'string' | 'lua';

let dialect: DispatchDialect | null = null;

/** Lua string literal: only quotes and backslashes need escaping here. */
function luaStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `{ k = v, … }`, dropping entries whose value is undefined. */
function luaTable(fields: Record<string, string | number | boolean | undefined>): string {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? luaStr(v) : String(v)}`)
    .join(', ');
  return `{ ${body} }`;
}

function unsupported(verb: string): never {
  throw new HyprError('DISPATCH_UNSUPPORTED', `no Lua translation for dispatcher "${verb}"`, {
    hint: 'Hyprland 0.56 only exposes the hl.dsp.* dispatchers; this verb is gone or belongs to a plugin.',
    recoverable: true,
  });
}

/**
 * Split a classic argument blob into its comma-separated fields. Callers pass
 * these either as one string ("name:agent,address:0x…") or as separate argv
 * entries, so both are flattened the same way.
 */
function fields(rest: string[]): string[] {
  return rest
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `[workspace name:agent silent] foot -e htop` → rules + the command. */
export function parseExecRules(arg: string): { rules: Record<string, string>; command: string } {
  const m = /^\s*\[([^\]]*)\]\s*(.*)$/s.exec(arg);
  if (!m) return { rules: {}, command: arg };
  const rules: Record<string, string> = {};
  for (const clause of (m[1] ?? '').split(';')) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp === -1) rules[trimmed] = 'true';
    else rules[trimmed.slice(0, sp)] = trimmed.slice(sp + 1).trim();
  }
  return { rules, command: m[2] ?? '' };
}

/**
 * The classic verbs this server actually dispatches, as `hl.dsp.*` calls.
 * Argument names come from Hyprland 0.56's LuaBindingsDispatchers.cpp — note
 * `follow = false` is what the old `…silent` suffix means, there is no
 * `silent` key.
 */
const LUA_DISPATCH: Record<string, (rest: string[]) => string> = {
  focuswindow: (rest) => `hl.dsp.focus(${luaTable({ window: fields(rest)[0] })})`,
  closewindow: (rest) => `hl.dsp.window.close(${luaTable({ window: fields(rest)[0] })})`,
  killactive: () => 'hl.dsp.window.kill()',
  workspace: (rest) => `hl.dsp.focus(${luaTable({ workspace: fields(rest)[0] })})`,
  togglespecialworkspace: (rest) => `hl.dsp.workspace.toggle_special(${luaStr(fields(rest)[0] ?? '')})`,

  movetoworkspace: (rest) => {
    const [ws, window] = fields(rest);
    return `hl.dsp.window.move(${luaTable({ workspace: ws, window })})`;
  },
  // "silent" = do not follow the window to its new workspace.
  movetoworkspacesilent: (rest) => {
    const [ws, window] = fields(rest);
    return `hl.dsp.window.move(${luaTable({ workspace: ws, follow: false, window })})`;
  },

  movecursor: (rest) => {
    const [x, y] = rest;
    return `hl.dsp.cursor.move(${luaTable({ x: Number(x), y: Number(y) })})`;
  },

  // "CTRL SHIFT, T, address:0x…"
  sendshortcut: (rest) => {
    const parts = rest.join(' ').split(',').map((s) => s.trim());
    return `hl.dsp.send_shortcut(${luaTable({ mods: parts[0] ?? '', key: parts[1] ?? '', window: parts[2] })})`;
  },

  exec: (rest) => {
    const { rules, command } = parseExecRules(rest.join(' '));
    const opts = Object.keys(rules).length > 0 ? `, ${luaTable(rules)}` : '';
    return `hl.dsp.exec_cmd(${luaStr(command)}${opts})`;
  },

  // Classic `fullscreen 1` = maximized, `fullscreen 0` = true fullscreen. The
  // classic dispatcher ignored a trailing selector; the Lua one honours it.
  fullscreen: (rest) => {
    const [mode, window] = fields(rest);
    return `hl.dsp.window.fullscreen(${luaTable({ mode: mode === '1' ? 'maximized' : 'fullscreen', window })})`;
  },
  togglefloating: (rest) => `hl.dsp.window.float(${luaTable({ action: 'toggle', window: fields(rest)[0] })})`,

  // `<w>x<h>,<selector>` — an exact size, hence relative = false.
  resizewindowpixel: (rest) => {
    const [size, window] = fields(rest);
    const [w, h] = (size ?? '').split('x');
    return `hl.dsp.window.resize(${luaTable({ x: Number(w), y: Number(h), relative: false, window })})`;
  },
  // `<x>,<y>,<selector>`, optionally prefixed "exact". The window tool means an
  // absolute position (the classic verb read bare numbers as a delta).
  movewindowpixel: (rest) => {
    const parts = fields(rest);
    const first = (parts[0] ?? '').replace(/^exact\s+/, '');
    const [x, y, window] = [first, parts[1], parts[2]];
    return `hl.dsp.window.move(${luaTable({ x: Number(x), y: Number(y), relative: false, window })})`;
  },
};

/** The request text for one dispatch, in the given dialect. */
export function dispatchRequest(args: string[], how: DispatchDialect): string {
  if (how === 'string') return `dispatch ${args.join(' ')}`;
  const [verb, ...rest] = args;
  const build = LUA_DISPATCH[verb ?? ''];
  if (!build) unsupported(verb ?? '');
  return `dispatch ${build(rest)}`;
}

/** Does this answer mean "wrong dialect" rather than "bad command"? */
export function isDialectError(reply: string): boolean {
  return /hl\.dispatch|expected a dispatcher|attempt to (call|index) a nil value|expected near/i.test(reply);
}

/**
 * Learn the dialect without changing anything: focusing a window address that
 * cannot exist is refused by every Hyprland, and *how* it is refused says
 * which parser answered.
 */
export async function probeDispatchDialect(cfg: HyprlandConfig): Promise<DispatchDialect> {
  if (dialect) return dialect;
  const reply = (await rawRequest(cfg, dispatchRequest(['focuswindow', 'address:0xffffffffffffffff'], 'string'))).trim();
  dialect = isDialectError(reply) ? 'lua' : 'string';
  return dialect;
}

/** The dialect in use, once known. */
export function dispatchDialect(): DispatchDialect | null {
  return dialect;
}

/** Reset the cached dialect (tests; a compositor restart). */
export function resetDispatchDialect(): void {
  dialect = null;
}

/**
 * Dispatch command. Hyprland replies "ok" or an error string.
 *
 * The dialect is probed before the first dispatch rather than guessed by
 * trying one and falling back: a classic string sent to a Lua compositor is
 * evaluated as Lua, and there is no guarantee a stray verb is inert.
 */
export async function dispatch(cfg: HyprlandConfig, args: string[]): Promise<void> {
  const how = await probeDispatchDialect(cfg);
  const request = dispatchRequest(args, how);
  const trimmed = (await rawRequest(cfg, request)).trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'ok') return;
  throw new HyprError('COMPOSITOR_UNAVAILABLE', `dispatch failed: ${trimmed}`, {
    hint: `Command: ${request}`,
    recoverable: false,
  });
}

/**
 * Mutex-serialized IPC client. All requests funnel through one queue so the
 * compositor never sees parallel socket1 connections (the 5s-freeze trigger).
 */
export class HyprIpc {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly cfg: HyprlandConfig) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  request(command: string): Promise<string> {
    return this.serialized(() => rawRequest(this.cfg, command));
  }

  json<T>(command: string): Promise<T> {
    return this.serialized(() => jsonRequest<T>(this.cfg, command));
  }

  /** Which dispatch dialect this compositor speaks (probed once). */
  dialect(): Promise<DispatchDialect> {
    return this.serialized(() => probeDispatchDialect(this.cfg));
  }

  dispatch(args: string[]): Promise<void> {
    return this.serialized(() => dispatch(this.cfg, args));
  }
}
