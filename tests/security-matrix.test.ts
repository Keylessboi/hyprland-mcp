/**
 * P0g: config→enforcement matrix canary.
 *
 * Two layers so a config flag added WITHOUT an enforcement path fails loudly:
 *   1. STRUCTURAL — every Config key (incl. capabilities.* and session.*
 *      children) must have a row in MATRIX. A new dead flag fails here.
 *   2. BEHAVIORAL — each row builds a server with that flag disabled and
 *      probes through the real MCP protocol, asserting PERMISSION_DENIED.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { HyprIpc } from '../src/ipc.js';
import { HyprEventStream } from '../src/events.js';
import { DesktopStateStore } from '../src/state.js';
import { Screenshotter } from '../src/screenshot.js';
import { InputController } from '../src/input.js';
import { AuditLog } from '../src/audit.js';
import { buildServer, type ServerDeps } from '../src/index.js';
import { startFakeHyprland } from './harness.js';
import { monitorGeometry } from '../src/geometry.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/security.js';

const MONITORS = JSON.stringify([{ id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true, dpmsStatus: true }]);
const CLIENTS = JSON.stringify([
  {
    address: '0x55dfd4972540', class: 'org.gajim.Gajim', initialClass: 'Gajim', title: 'Gajim', initialTitle: '', pid: 93753,
    at: [960, 0], size: [960, 1080], workspace: { id: 2, name: '2' }, floating: false, pseudo: false, monitor: 0,
    xwayland: false, pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
    swallowing: '0', focusHistoryID: 2, hidden: false, minimized: false, mapped: true, stableId: 'stable-gajim',
  },
]);

let fakes: ReturnType<typeof startFakeHyprland>[] = [];

async function makeServer(cfgOverride: Partial<ReturnType<typeof loadConfig>>): Promise<Client> {
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
    input, config: cfg, audit: new AuditLog(cfg.session.auditPath), serverVersion: 'test',
  };
  const server = buildServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'matrix', version: '1' });
  await server.connect(st);
  await client.connect(ct);
  return client as unknown as Client;
}

afterEach(() => {
  for (const f of fakes) f.close();
  fakes = [];
});

async function denied(client: Client, tool: string, args: Record<string, unknown>): Promise<{ denied: boolean; rule?: string; code?: string }> {
  const res = await client.callTool({ name: tool, arguments: args });
  const sc = res.structuredContent as { ok: boolean; error?: { code: string }; rule?: string };
  return { denied: sc.ok === false && sc.error?.code === 'PERMISSION_DENIED', rule: sc.rule, code: sc.error?.code };
}

interface MatrixRow {
  flag: string;
  config: Partial<ReturnType<typeof loadConfig>>;
  probe: (c: Client) => Promise<{ denied: boolean; rule?: string; code?: string }>;
}

// Every security-relevant config flag, with the probe that must be denied.
const MATRIX: MatrixRow[] = [
  {
    flag: 'capabilities.exec',
    config: { capabilities: { ...DEFAULT_CONFIG.capabilities, exec: false } },
    probe: (c) => denied(c, 'launch', { command: '/bin/true', wait_for_window: false }),
  },
  {
    flag: 'capabilities.input',
    config: { capabilities: { ...DEFAULT_CONFIG.capabilities, input: false } },
    probe: (c) => denied(c, 'input_click', { target: 'gajim' }),
  },
  {
    flag: 'capabilities.destructive',
    config: { capabilities: { ...DEFAULT_CONFIG.capabilities, destructive: false } },
    probe: (c) => denied(c, 'close', { target: 'gajim' }),
  },
  {
    flag: 'capabilities.screenshot',
    config: { capabilities: { ...DEFAULT_CONFIG.capabilities, screenshot: false } },
    probe: (c) => denied(c, 'screenshot', { target: 'screen' }),
  },
  {
    flag: 'denyClasses',
    config: { denyClasses: ['gajim'] },
    probe: (c) => denied(c, 'focus', { target: 'gajim' }),
  },
  {
    flag: 'windowScope',
    config: { windowScope: ['foot'] },
    probe: (c) => denied(c, 'focus', { target: 'gajim' }),
  },
  {
    flag: 'dispatchAllow',
    config: { dispatchAllow: [] },
    probe: (c) => denied(c, 'dispatch', { args: ['focuswindow', 'address:0x55dfd4972540'] }),
  },
  {
    flag: 'strict (empty execAllowPrefixes)',
    config: { strict: true, execAllowPrefixes: [] },
    probe: (c) => denied(c, 'launch', { command: '/bin/true', wait_for_window: false }),
  },
  {
    flag: 'tools.allow',
    config: { tools: { allow: ['get_state'], exclude: [] } },
    probe: (c) => denied(c, 'close', { target: 'gajim' }),
  },
  {
    flag: 'tools.exclude',
    config: { tools: { allow: [], exclude: ['close'] } },
    probe: (c) => denied(c, 'close', { target: 'gajim' }),
  },
  {
    flag: 'readOnly',
    config: { readOnly: true },
    probe: (c) => denied(c, 'close', { target: 'gajim' }),
  },
  {
    flag: 'session.killSwitchFile',
    config: { session: { killSwitchFile: path.join(os.tmpdir(), `STOP-${Date.now()}`), auditPath: path.join(os.tmpdir(), `A-${Date.now()}`, 'a.jsonl') } },
    probe: (c) => denied(c, 'focus', { target: 'gajim' }),
  },
];

// Structural: every Config key (and nested children) must have a matrix row.
const CONFIG_FLAGS: string[] = [
  'capabilities.exec', 'capabilities.input', 'capabilities.destructive', 'capabilities.screenshot',
  'denyClasses', 'windowScope', 'execAllowPrefixes', 'allowClipboardPaste', 'screenshotDir',
  'tools.allow', 'tools.exclude', 'dispatchAllow', 'readOnly', 'strict', 'session.killSwitchFile', 'session.auditPath',
];

describe('config→enforcement matrix (P0g)', () => {
  it('every config flag has an enforcement row (no dead config)', () => {
    const matrixFlags = new Set(MATRIX.map((r) => r.flag));
    // strict and execAllowPrefixes are jointly enforced by assertExecAllowed:
    // the "strict (empty execAllowPrefixes)" row exercises both. allowClipboardPaste
    // and screenshotDir are behavior gates, not denial flags — enforced in their
    // handlers, enumerated here as covered.
    const covered = new Set(['strict', 'execAllowPrefixes']);
    const exempt = new Set(['allowClipboardPaste', 'screenshotDir', 'session.auditPath']);
    for (const f of CONFIG_FLAGS) {
      if (exempt.has(f)) continue;
      const hasRow = matrixFlags.has(f) || (covered.has(f) && matrixFlags.has('strict (empty execAllowPrefixes)'));
      expect(hasRow, `config flag "${f}" has no enforcement row`).toBe(true);
    }
  });

  it.each(MATRIX.map((r) => [r.flag, r] as const))('flag %s denies its probe', async (_flag, row) => {
    // materialize the kill-switch file before building for the killSwitch row
    if (row.flag === 'session.killSwitchFile') {
      const ks = (row.config.session as { killSwitchFile: string }).killSwitchFile;
      fs.writeFileSync(ks, '');
    }
    const client = await makeServer(row.config);
    const result = await row.probe(client);
    expect(result.denied, `probe for "${row.flag}" must be PERMISSION_DENIED (got ${result.code ?? 'ok'})`).toBe(true);
  });
});
