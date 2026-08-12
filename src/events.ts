/**
 * Events — socket2 listener (hyprland event stream).
 *
 * Lines are `EVENT>>payload`. We split on the FIRST `>>`. Events are an
 * optimization for reactivity; the compositor (via socket1 re-query) remains
 * the source of truth (deep 1b: no geometry event exists, so caches must
 * never be trusted for at/size).
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { HyprlandConfig } from './ipc.js';

export function eventSocketPath(cfg: HyprlandConfig): string {
  return `${cfg.socketDir}/.socket2.sock`;
}

export type HyprEvent =
  | { event: 'workspace'; payload: string }
  | { event: 'focusedmon'; payload: string }
  | { event: 'activewindow'; payload: string }
  | { event: 'activewindowv2'; payload: string }
  | { event: 'openwindow'; payload: string }
  | { event: 'closewindow'; payload: string }
  | { event: 'movewindow'; payload: string }
  | { event: 'windowtitle'; payload: string }
  | { event: 'windowtitlev2'; payload: string }
  | { event: 'fullscreen'; payload: string }
  | { event: 'monitoradded'; payload: string }
  | { event: 'monitorremoved'; payload: string }
  | { event: 'configreloaded'; payload: string }
  | { event: 'minimized'; payload: string }
  | { event: 'custom'; payload: string }
  | { event: string; payload: string }; // unknown events pass through defensively

export interface EventListenerOptions {
  timeoutMs?: number;
}

/**
 * Connects to socket2, parses lines, reconnects with backoff on EOF.
 * Events emitted as {event, payload}. Errors (compositor restart) are emitted
 * as 'disconnect' for the owner to trigger full resync.
 */
export class HyprEventStream extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf = '';
  private stopped = false;
  private retryMs = 500;

  constructor(
    private cfg: HyprlandConfig,
    private opts: EventListenerOptions = {},
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.sock?.destroy();
    this.sock = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const sock = net.createConnection({ path: eventSocketPath(this.cfg) });
    this.sock = sock;

    sock.on('connect', () => {
      this.retryMs = 500;
      this.emit('connected');
    });

    sock.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line.length > 0) this.parseLine(line);
      }
    });

    sock.on('error', () => {
      // connection errors surface as disconnect; reconnect logic below
    });

    sock.on('close', () => {
      this.sock = null;
      this.emit('disconnect');
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 10_000);
      }
    });
  }

  private parseLine(line: string): void {
    const sep = line.indexOf('>>');
    if (sep < 0) {
      this.emit('event', { event: 'unknown', payload: line } satisfies HyprEvent);
      return;
    }
    const event = line.slice(0, sep);
    const payload = line.slice(sep + 2);
    this.emit('event', { event, payload } satisfies HyprEvent);
  }

  /**
   * Wait until predicate matches an event, or timeout.
   * Used for launch readiness (openwindow) and post-act verification.
   */
  waitFor(predicate: (e: HyprEvent) => boolean, timeoutMs: number): Promise<HyprEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('event', handler);
        reject(new Error(`event wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (e: HyprEvent) => {
        if (predicate(e)) {
          clearTimeout(timer);
          this.off('event', handler);
          resolve(e);
        }
      };
      this.on('event', handler);
    });
  }
}
