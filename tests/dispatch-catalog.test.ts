/**
 * P0d: dispatch allow-by-default catalog regression (tests/security-matrix.md §4b).
 *
 * The catalog is asserted, not incidental: ungated dispatchers must fail closed
 * with a structured PERMISSION_DENIED and ZERO compositor dispatch lines.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { SAFE_DISPATCH_CATALOG, loadConfig } from '../src/security.js';
import type { FakeHyprland } from './harness.js';

// Reuse the makeServer pattern from mcp.test.ts via a tiny local duplicate to
// keep this file self-contained: build a server with a config override + the
// fake socket, return { client, fake }.
import { Client as McpClient, InMemoryTransport } from '@modelcontextprotocol/client';
import { HyprIpc } from '../src/ipc.js';
import { HyprEventStream } from '../src/events.js';
import { DesktopStateStore } from '../src/state.js';
import { Screenshotter } from '../src/screenshot.js';
import { InputController } from '../src/input.js';
import { AuditLog } from '../src/audit.js';
import { buildServer, type ServerDeps } from '../src/index.js';
import { startFakeHyprland } from './harness.js';
import { monitorGeometry } from '../src/geometry.js';

const MONITORS = JSON.stringify([{ id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true, dpmsStatus: true }]);
const CLIENTS = JSON.stringify([
  {
    address: '0x55dfd4972540', class: 'org.gajim.Gajim', initialClass: 'Gajim', title: 'Gajim', initialTitle: '', pid: 93753,
    at: [960, 0], size: [960, 1080], workspace: { id: 2, name: '2' }, floating: false, pseudo: false, monitor: 0,
    xwayland: false, pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
    swallowing: '0', focusHistoryID: 2, hidden: false, minimized: false, mapped: true, stableId: 'stable-gajim',
  },
]);

let fakes: FakeHyprland[] = [];

async function makeServer(cfgOverride: Partial<ReturnType<typeof loadConfig>>): Promise<{ client: Client; fake: FakeHyprland }> {
  const fake = await startFakeHyprland({
    respond: {
      'j/monitors': MONITORS,
      'j/workspaces': JSON.stringify([{ id: 1, name: '1', windows: 1 }, { id: 2, name: '2', windows: 1 }]),
      'j/clients': CLIENTS,
      'j/activewindow': JSON.stringify({}),
      'j/activewindowv2': JSON.stringify({ address: '0x55dfd4972540' }),
      'cursorpos': '960, 540',
      'version': 'Hyprland 0.56.2',
      'j/locked': JSON.stringify({ locked: false }),
      'dispatch *': 'ok',
    },
  });
  fakes.push(fake);
  const ipc = new HyprIpc({ socketDir: fake.dir });
  const events = new HyprEventStream({ socketDir: fake.dir });
  const state = new DesktopStateStore(ipc);
  const monitors = JSON.parse(MONITORS).map(monitorGeometry);
  const screenshots = new Screenshotter(
    { async run(bin: string, args: string[]) { void bin; void args; return { stdout: Buffer.from([1, 2, 3]), stderr: '', code: 0 }; } },
    monitors,
  );
  const input = new InputController(ipc, { async run() { return { stdout: '', stderr: '', code: 0 }; } }, { async assertFocused() {} }, { allowUnicodePaste: true });
  const cfg = { ...loadConfig(), screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-shot-')), ...cfgOverride };
  const deps: ServerDeps = {
    ipc, events, state, screenshots,
    ocr: { async readImage() { return { text: '', words: [] }; } } as never,
    input,
    config: cfg,
    audit: new AuditLog(cfg.session.auditPath),
    serverVersion: 'test',
  };
  const server = buildServer(deps);
  const factory: () => ReturnType<typeof buildServer> = () => server;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: 'test', version: '1' });
  await factory();
  await server.connect(st);
  await client.connect(ct);
  return { client: client as unknown as Client, fake };
}

afterEach(() => {
  for (const f of fakes) f.close();
  fakes = [];
});

describe('dispatch catalog (P0d)', () => {
  it('default catalog is the exact frozen safe set', () => {
    expect([...SAFE_DISPATCH_CATALOG].sort()).toEqual([
      'closewindow', 'focuswindow', 'fullscreen', 'movecursor', 'movetoworkspacesilent',
      'movewindowpixel', 'resizewindowpixel', 'sendshortcut', 'togglefloating',
      'togglespecialworkspace', 'workspace',
    ].sort());
  });

  it('every cataloged dispatcher runs', async () => {
    const { client } = await makeServer({});
    for (const d of SAFE_DISPATCH_CATALOG) {
      const res = await client.callTool({ name: 'dispatch', arguments: { args: [d, 'x'] } });
      const sc = res.structuredContent as { ok: boolean };
      expect(sc.ok, `dispatcher ${d} should be allowed`).toBe(true);
    }
  });

  it('ungated dispatchers fail closed (exit / killwindow / invented / empty)', async () => {
    const { client, fake } = await makeServer({});
    for (const bad of ['exit', 'killwindow', 'totally-invented', '']) {
      const res = await client.callTool({ name: 'dispatch', arguments: { args: bad ? [bad] : [''] } });
      const sc = res.structuredContent as { ok: boolean; error: { code: string } | undefined; rule?: string };
      expect(sc.ok, `dispatcher "${bad}" must be denied`).toBe(false);
      expect(sc.error?.code).toBe('PERMISSION_DENIED');
      expect(sc.rule).toBe('dispatchAllow');
    }
    // and the compositor received nothing
    const dispatchLines = fake.received().filter((r) => r.startsWith('dispatch ') && !r.startsWith('dispatch exec '));
    expect(dispatchLines).toHaveLength(0);
  });

  it('sendclick requires explicit dispatchAllow opt-in', async () => {
    const { client } = await makeServer({});
    const denied = await client.callTool({ name: 'dispatch', arguments: { args: ['sendclick', 'x:1,y:1'] } });
    expect((denied.structuredContent as { ok: boolean }).ok).toBe(false);
    const { client: c2 } = await makeServer({ dispatchAllow: [...SAFE_DISPATCH_CATALOG, 'sendclick'] });
    const allowed = await c2.callTool({ name: 'dispatch', arguments: { args: ['sendclick', 'x:1,y:1'] } });
    expect((allowed.structuredContent as { ok: boolean }).ok).toBe(true);
  });

  it('exec dispatcher requires capabilities.exec', async () => {
    const { client } = await makeServer({ capabilities: { ...loadConfig().capabilities, exec: false } });
    const res = await client.callTool({ name: 'dispatch', arguments: { args: ['exec', 'firefox'] } });
    const sc = res.structuredContent as { ok: boolean; error: { code: string } | undefined };
    expect(sc.ok).toBe(false);
    expect(sc.error?.code).toBe('PERMISSION_DENIED');
  });

  it('exec dispatcher honors execAllowPrefixes (strict refuses empty)', async () => {
    const { client } = await makeServer({ strict: true, execAllowPrefixes: [] });
    const res = await client.callTool({ name: 'dispatch', arguments: { args: ['exec', 'firefox'] } });
    const sc = res.structuredContent as { ok: boolean; error: { code: string } | undefined };
    expect(sc.ok).toBe(false);
    expect(sc.error?.code).toBe('PERMISSION_DENIED');

    const { client: c2 } = await makeServer({ execAllowPrefixes: ['firefox'] });
    const ok = await c2.callTool({ name: 'dispatch', arguments: { args: ['exec', 'firefox'] } });
    expect((ok.structuredContent as { ok: boolean }).ok).toBe(true);
  });
});
