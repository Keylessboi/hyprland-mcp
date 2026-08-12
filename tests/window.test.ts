/**
 * WIN-01 — window addressing (scenarios/window-addressing.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HyprIpc } from '../src/ipc.js';
import { DesktopStateStore } from '../src/state.js';
import { startFakeHyprland, type FakeHyprland } from './harness.js';

let fake: FakeHyprland;
let store: DesktopStateStore;
let fakes: FakeHyprland[] = [];

const CLIENTS = JSON.stringify([
  {
    address: '0x55dfd4156230', class: 'chromium', initialClass: 'chromium',
    title: 'Omi AI - Note taker', initialTitle: '', pid: 2077,
    at: [0, 0], size: [960, 1080], workspace: { id: 1, name: '1' },
    floating: false, pseudo: false, monitor: 0, xwayland: false,
    pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
    swallowing: '0', focusHistoryID: 3, hidden: false, minimized: false, mapped: true,
  },
  {
    address: '0x55dfd4156231', class: 'chromium', initialClass: 'chromium',
    title: 'Chrome helper window', initialTitle: '', pid: 2090,
    at: [0, 0], size: [960, 1080], workspace: { id: 1, name: '1' },
    floating: false, pseudo: false, monitor: 0, xwayland: false,
    pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
    swallowing: '0', focusHistoryID: 4, hidden: false, minimized: false, mapped: true,
  },
  {
    address: '0x55dfd4972540', class: 'org.gajim.Gajim', initialClass: 'Gajim',
    title: 'Gajim', initialTitle: '', pid: 93753,
    at: [960, 0], size: [960, 1080], workspace: { id: 2, name: '2' },
    floating: false, pseudo: false, monitor: 0, xwayland: false,
    pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
    swallowing: '0', focusHistoryID: 2, hidden: false, minimized: false, mapped: true,
  },
]);

beforeEach(async () => {
  fake = await startFakeHyprland({
    respond: {
      'j/monitors': JSON.stringify([{ id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1 }]),
      'j/workspaces': JSON.stringify([{ id: 1, name: '1', windows: 2 }, { id: 2, name: '2', windows: 1 }]),
      'j/clients': CLIENTS,
      'j/activewindow': JSON.stringify({}),
      'j/activewindowv2': JSON.stringify({}),
      'cursorpos': '960, 540',
      'version': 'Hyprland 0.56.2',
    },
  });
  fakes.push(fake);
  store = new DesktopStateStore(new HyprIpc({ socketDir: fake.dir }));
});

afterEach(() => {
  for (const f of fakes) f.close();
  fakes = [];
});

describe('WIN-01 window addressing', () => {
  it('resolves an exact address to exactly one window', async () => {
    const hits = await store.resolveWindow('0x55dfd4972540');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.class).toBe('org.gajim.Gajim');
  });

  it('resolves a unique class', async () => {
    const hits = await store.resolveWindow('gajim');
    expect(hits).toHaveLength(1);
  });

  it('returns ALL matches for an ambiguous substring (never silent first-match)', async () => {
    const hits = await store.resolveWindow('chromium');
    expect(hits).toHaveLength(2); // both chromium windows
  });

  it('returns zero for no match', async () => {
    const hits = await store.resolveWindow('nothing-matches-this');
    expect(hits).toHaveLength(0);
  });

  it('resolves by pid', async () => {
    const hits = await store.resolveWindow(2077);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.class).toBe('chromium');
  });

  it('first-match mode returns only the first hit', async () => {
    const hits = await store.resolveWindow('chromium', { match: 'first' });
    expect(hits).toHaveLength(1);
  });
});
