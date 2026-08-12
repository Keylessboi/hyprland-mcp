/**
 * State — advisory cache with poll-verify discipline (adversary A1 + deep 1b).
 *
 * Hyprland emits NO geometry events. at/size drift with no invalidation
 * signal. Therefore: the cache is only ever a hint; every act re-queries
 * `clients -j` first, and mutating ops poll-verify their own effect.
 */
import { HyprIpc } from './ipc.js';
import {
  DesktopState,
  HyprMonitor,
  HyprWindow,
  HyprWorkspace,
} from './types.js';

export class DesktopStateStore {
  private last: DesktopState | null = null;
  private lastAt = 0;

  constructor(private ipc: HyprIpc) {}

  /** Fresh snapshot from the compositor (socket1 is the source of truth). */
  async snapshot(): Promise<DesktopState> {
    const [monitors, workspaces, clients, activeWindow, cursorpos, version] = await Promise.all([
      this.ipc.json<HyprMonitor[]>('monitors'),
      this.ipc.json<HyprWorkspace[]>('workspaces'),
      this.ipc.json<HyprWindow[]>('clients'),
      this.ipc.json<HyprWindow>('activewindow').catch(() => null),
      this.ipc.request('cursorpos').catch(() => '0, 0'),
      this.ipc.request('version').catch(() => 'unknown'),
    ]);

    let pos: [number, number] | null = null;
    const m = cursorpos.match(/(-?\d+),\s*(-?\d+)/);
    if (m) pos = [parseInt(m[1]!, 10), parseInt(m[2]!, 10)];

    const state: DesktopState = {
      monitors,
      workspaces,
      clients,
      activeWindow: activeWindow && Object.keys(activeWindow).length > 0 ? activeWindow : null,
      cursorpos: pos,
      version: version.trim(),
    };
    this.last = state;
    this.lastAt = Date.now();
    return state;
  }

  /** Cached snapshot if fresh (< maxAgeMs), else re-query. */
  async get(maxAgeMs = 250): Promise<DesktopState> {
    if (this.last && Date.now() - this.lastAt < maxAgeMs) return this.last;
    return this.snapshot();
  }

  /** Resolve a window selector: address / class / initialClass / title / pid. */
  async resolveWindow(
    selector: string | number,
    opts?: { match?: 'first' | 'all'; requireUnique?: boolean },
  ): Promise<HyprWindow[]> {
    const state = await this.snapshot();
    const match = opts?.match ?? 'all';
    const q = String(selector).toLowerCase();
    const isAddr = /^0x[0-9a-f]+$/i.test(String(selector));

    let hits: HyprWindow[];
    if (isAddr) {
      hits = state.clients.filter((c) => c.address.toLowerCase() === String(selector).toLowerCase());
    } else if (typeof selector === 'number' || /^\d+$/.test(q)) {
      const pid = typeof selector === 'number' ? selector : parseInt(q, 10);
      hits = state.clients.filter((c) => c.pid === pid);
    } else {
      hits = state.clients.filter(
        (c) =>
          c.address.toLowerCase().includes(q) ||
          c.class.toLowerCase().includes(q) ||
          c.initialClass.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q),
      );
    }

    if (match === 'first') return hits.slice(0, 1);
    return hits;
  }
}
