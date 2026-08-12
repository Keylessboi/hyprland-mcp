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
      sock.write(command + '\n');
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

/** Dispatch command (`dispatch ...`). Hyprland replies "ok" or an error string. */
export async function dispatch(cfg: HyprlandConfig, args: string[]): Promise<void> {
  const raw = await rawRequest(cfg, `dispatch ${args.join(' ')}`);
  const trimmed = raw.trim();
  if (trimmed.length > 0 && trimmed.toLowerCase() !== 'ok') {
    throw new HyprError('COMPOSITOR_UNAVAILABLE', `dispatch failed: ${trimmed}`, {
      hint: `Command: dispatch ${args.join(' ')}`,
      recoverable: false,
    });
  }
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

  dispatch(args: string[]): Promise<void> {
    return this.serialized(() => dispatch(this.cfg, args));
  }
}
