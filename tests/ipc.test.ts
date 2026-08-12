/**
 * IPC-01 — the freeze contract (scenarios/ipc-freeze-contract.md).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HyprIpc, rawRequest } from '../src/ipc.js';
import { startFakeHyprland, type FakeHyprland } from './harness.js';

let fakes: FakeHyprland[] = [];
afterEach(() => {
  for (const f of fakes) f.close();
  fakes = [];
});

const MONITORS_JSON = JSON.stringify([{ id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true }]);

describe('IPC-01 freeze contract', () => {
  it('connect-write-read-close per request: each request opens a fresh connection', async () => {
    const fake = await startFakeHyprland({ respond: { 'j/monitors': MONITORS_JSON } });
    fakes.push(fake);
    const ipc = new HyprIpc({ socketDir: fake.dir });

    await ipc.json<unknown[]>('monitors');
    await ipc.json<unknown[]>('monitors');
    await ipc.json<unknown[]>('monitors');

    expect(fake.connectionCount()).toBe(3); // never reused
    expect(fake.received()).toEqual(['j/monitors', 'j/monitors', 'j/monitors']);
  });

  it('serializes concurrent requests: no parallel socket1 traffic', async () => {
    let inFlight = 0;
    let peak = 0;
    const fake = await startFakeHyprland({
      respond: {
        'j/monitors': async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 30));
          inFlight--;
          return MONITORS_JSON;
        },
      },
    });
    fakes.push(fake);
    const ipc = new HyprIpc({ socketDir: fake.dir });

    await Promise.all([ipc.json('monitors'), ipc.json('monitors'), ipc.json('monitors')]);
    expect(peak).toBe(1); // mutex: never more than one outstanding
  });

  it('times out with IPC_TIMEOUT when the compositor hangs', async () => {
    const fake = await startFakeHyprland({ respond: {}, hang: true });
    fakes.push(fake);
    const ipc = new HyprIpc({ socketDir: fake.dir, timeoutMs: 200 });

    await expect(ipc.json('monitors')).rejects.toMatchObject({ code: 'IPC_TIMEOUT' });
  });

  it('fails with COMPOSITOR_UNAVAILABLE when the socket is missing', async () => {
    await expect(rawRequest({ socketDir: '/nonexistent/hypr/xyz' }, 'j/monitors')).rejects.toMatchObject({
      code: 'COMPOSITOR_UNAVAILABLE',
    });
  });

  it('propagates dispatch error text from the compositor', async () => {
    const fake = await startFakeHyprland({ respond: { 'dispatch focuswindow address:0x1': 'error: invalid' } });
    fakes.push(fake);
    const ipc = new HyprIpc({ socketDir: fake.dir });

    await expect(ipc.dispatch(['focuswindow', 'address:0x1'])).rejects.toMatchObject({
      code: 'COMPOSITOR_UNAVAILABLE',
    });
  });
});
