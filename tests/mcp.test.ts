/**
 * MCP-level integration: boot the real server over InMemoryTransport,
 * assert tools/list and callTool round-trips through the actual protocol.
 *
 * Deps are real modules wired to a fake Hyprland socket + fake input runner,
 * so nothing touches the live desktop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { HyprIpc } from '../src/ipc.js';
import { HyprEventStream } from '../src/events.js';
import { DesktopStateStore } from '../src/state.js';
import { Screenshotter } from '../src/screenshot.js';
import { InputController, type InputBackend } from '../src/input.js';
import { loadConfig } from '../src/security.js';
import { buildServer, type ServerDeps } from '../src/index.js';
import { AuditLog } from '../src/audit.js';
import { startFakeHyprland, type FakeHyprland } from './harness.js';
import { monitorGeometry } from '../src/geometry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MONITORS = JSON.stringify([{ id: 0, name: 'eDP-1', width: 1920, height: 1080, x: 0, y: 0, scale: 1, focused: true, dpmsStatus: true }]);
const CLIENTS = JSON.stringify([
  {
    address: '0x55dfd4972540', class: 'org.gajim.Gajim', initialClass: 'Gajim', title: 'Gajim', initialTitle: '', pid: 93753,
    at: [960, 0], size: [960, 1080], workspace: { id: 2, name: '2' }, floating: false, pseudo: false, monitor: 0,
    xwayland: false, pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
    swallowing: '0', focusHistoryID: 2, hidden: false, minimized: false, mapped: true, stableId: 'stable-gajim',
  },
]);

class FakeInput implements InputBackend {
  calls: string[][] = [];
  async run(bin: string, args: string[]) {
    this.calls.push([bin, ...args]);
    return { stdout: '', stderr: '', code: 0 };
  }
}

let fake: FakeHyprland;
let client: Client;
let inputFake: FakeInput;
let fakes: FakeHyprland[] = [];
let mutableConfig: ReturnType<typeof loadConfig>;

function setConfig(overrides: Partial<ReturnType<typeof loadConfig>>): void {
  Object.assign(mutableConfig, overrides);
}

/** Build a fresh server+client with the config baked in at registration time.
 *  Registration-time policies (tools.allow/exclude, readOnly) are fixed when
 *  tools register, so they need a server built with the config from the start. */
async function makeServer(cfgOverride: Partial<ReturnType<typeof loadConfig>>): Promise<Client> {
  const f = await startFakeHyprland({
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
  fakes.push(f);
  const ipc = new HyprIpc({ socketDir: f.dir });
  const events = new HyprEventStream({ socketDir: f.dir });
  const state = new DesktopStateStore(ipc);
  const monitors = JSON.parse(MONITORS).map(monitorGeometry);
  const screenshots = new Screenshotter(
    {
      async run(bin: string, args: string[]) {
        void bin;
        void args;
        return { stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), stderr: '', code: 0 };
      },
    },
    monitors,
  );
  const input = new InputController(
    ipc,
    new FakeInput(),
    { async assertFocused() { /* fake guard passes */ } },
    { allowUnicodePaste: true },
  );
  const cfg = { ...loadConfig(), screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-shot-')), ...cfgOverride };
  const deps: ServerDeps = {
    ipc,
    events,
    state,
    screenshots,
    ocr: {
      async readImage() {
        return { text: 'Save Changes Cancel', words: [
          { text: 'Save', left: 21, top: 42, width: 42, height: 10, confidence: 90 },
          { text: 'Changes', left: 44, top: 42, width: 42, height: 10, confidence: 90 },
          { text: 'Cancel', left: 90, top: 42, width: 50, height: 10, confidence: 90 },
        ] };
      },
    } as never,
    input,
    config: cfg,
    audit: new AuditLog(cfg.session.auditPath),
    serverVersion: 'test',
  };
  const server = buildServer(deps);
  const factory: McpServerFactory = () => server;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test-client', version: '1.0.0' });
  await factory();
  await server.connect(st);
  await c.connect(ct);
  return c;
}

beforeEach(async () => {
  fake = await startFakeHyprland({
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
    {
      async run(bin: string, args: string[]) {
        // grim would run for real; fake a tiny valid PNG
        void bin;
        void args;
        return { stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]), stderr: '', code: 0 };
      },
    },
    monitors,
  );
  inputFake = new FakeInput();
  const input = new InputController(
    ipc,
    inputFake,
    { async assertFocused() { /* fake guard passes */ } },
    { allowUnicodePaste: true },
  );

  const deps: ServerDeps = {
    ipc,
    events,
    state,
    screenshots,
    ocr: {
      async readImage() {
        return { text: 'Save Changes Cancel', words: [
          { text: 'Save', left: 21, top: 42, width: 42, height: 10, confidence: 90 },
          { text: 'Changes', left: 44, top: 42, width: 42, height: 10, confidence: 90 },
          { text: 'Cancel', left: 90, top: 42, width: 50, height: 10, confidence: 90 },
        ] };
      },
    } as never,
    input,
    config: { ...loadConfig(), screenshotDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-shot-')) },
    audit: new AuditLog(path.join(os.tmpdir(), `hypr-audit-${Date.now()}`, 'audit.jsonl')),
    serverVersion: 'test',
  };
  mutableConfig = deps.config;

  const server = buildServer(deps);
  const factory: McpServerFactory = () => server;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await factory();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  events.start();
});

afterEach(async () => {
  try {
    await client.close();
  } catch {
    /* already closed */
  }
  for (const f of fakes) f.close();
  fakes = [];
});

describe('MCP server over protocol', () => {
  it('exposes the expected tool surface', async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).sort();
    expect(names).toContain('get_state');
    expect(names).toContain('list_windows');
    expect(names).toContain('launch');
    expect(names).toContain('focus');
    expect(names).toContain('close');
    expect(names).toContain('kill');
    expect(names).toContain('workspace');
    expect(names).toContain('screenshot');
    expect(names).toContain('input_click');
    expect(names).toContain('input_type');
    expect(names).toContain('input_key');
    expect(names).toContain('input_paste');
    expect(names).toContain('dispatch');
    expect(names).toContain('health');
  });

  it('get_state returns the desktop snapshot', async () => {
    const res = await client.callTool({ name: 'get_state', arguments: {} });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('org.gajim.Gajim');
    expect(text).toContain('eDP-1');
  });

  it('list_windows filters by substring', async () => {
    const res = await client.callTool({ name: 'list_windows', arguments: { filter: 'gajim' } });
    const text = res.content.find((c) => c.type === 'text')?.text ?? '';
    expect(text).toContain('org.gajim.Gajim');
    expect(text).not.toContain('chromium');
  });

  it('focus dispatches focuswindow to the resolved address', async () => {
    const res = await client.callTool({ name: 'focus', arguments: { target: 'gajim' } });
    expect(fake.received()).toContain('dispatch focuswindow address:0x55dfd4972540');
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
  });

  it('input_type routes through wtype via the input runner (focus guard passes)', async () => {
    const res = await client.callTool({ name: 'input_type', arguments: { text: 'hello', target: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
    expect(inputFake.calls.some((c) => c[0] === 'wtype')).toBe(true);
  });

  it('unknown window returns WINDOW_NOT_FOUND isError', async () => {
    const res = await client.callTool({ name: 'focus', arguments: { target: 'does-not-exist' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { ok: boolean; error: { code: string } };
    expect(sc.error.code).toBe('WINDOW_NOT_FOUND');
  });

  it('input_click uses the sendclick plugin dispatch when available (no ydotool)', async () => {
    fake.respond['plugin list'] = 'Plugin hyprland-mcp-click by Keylessboi:\n\tenabled: true';
    const res = await client.callTool({ name: 'input_click', arguments: { target: 'gajim', button: 'right' } });
    const sc = res.structuredContent as { ok: boolean; result: { plugin: boolean } };
    expect(sc.ok).toBe(true);
    expect(sc.result.plugin).toBe(true);
    // single atomic dispatch, nothing routed through ydotool
    expect(fake.received().filter((r) => r.startsWith('dispatch sendclick'))).toHaveLength(1);
    expect(fake.received().filter((r) => r.startsWith('dispatch movetoworkspacesilent'))).toHaveLength(0);
    expect(fake.received().filter((r) => r.startsWith('dispatch togglespecialworkspace'))).toHaveLength(0);
    expect(inputFake.calls.filter((c) => c[0] === 'ydotool')).toHaveLength(0);
  });

  it('input_click falls back to the multi-step path when the plugin is absent', async () => {
    fake.respond['plugin list'] = 'no plugins';
    const res = await client.callTool({ name: 'input_click', arguments: { target: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
    // legacy path: no sendclick dispatch, ydotool used for the button
    expect(fake.received().filter((r) => r.startsWith('dispatch sendclick'))).toHaveLength(0);
    expect(inputFake.calls.filter((c) => c[0] === 'ydotool')).toHaveLength(1);
  });

  it('screenshot writes a file path a vision subagent can read', async () => {
    const res = await client.callTool({ name: 'screenshot', arguments: { target: 'window', window: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean; result: { file: string } };
    expect(sc.ok).toBe(true);
    expect(sc.result.file).toBeTruthy();
    expect(fs.existsSync(sc.result.file)).toBe(true);
    // the file is a real image artifact, not the empty capture
    const bytes = fs.readFileSync(sc.result.file);
    expect(bytes.length).toBeGreaterThan(8);
  });

  it('input and screenshot tools refuse with SESSION_LOCKED while the desktop is locked', async () => {
    fake.respond['j/locked'] = JSON.stringify({ locked: true });

    const shot = await client.callTool({ name: 'screenshot', arguments: { target: 'screen' } });
    expect(shot.isError).toBe(true);
    const shotSc = shot.structuredContent as { error: { code: string } };
    expect(shotSc.error.code).toBe('SESSION_LOCKED');

    const click = await client.callTool({ name: 'input_click', arguments: { target: 'gajim' } });
    const clickSc = click.structuredContent as { error: { code: string } };
    expect(clickSc.error.code).toBe('SESSION_LOCKED');

    const type = await client.callTool({ name: 'input_type', arguments: { text: 'hello', target: 'gajim' } });
    const typeSc = type.structuredContent as { error: { code: string } };
    expect(typeSc.error.code).toBe('SESSION_LOCKED');

    // no input or capture actually reached the compositor
    expect(inputFake.calls).toHaveLength(0);
  });

  it('input tools work normally while the desktop is unlocked', async () => {
    const res = await client.callTool({ name: 'input_type', arguments: { text: 'hi', target: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
    expect(inputFake.calls.some((c) => c[0] === 'wtype')).toBe(true);
  });

  // LAUNCH-01 (scenarios/launch-into-workspace.md): named-workspace launch
  it('launch with workspace name:agent dispatches exec [workspace name:agent] and quotes args', async () => {
    const res = await client.callTool({
      name: 'launch',
      arguments: { command: 'kitty', args: ['--title', 'agent shell'], workspace: 'name:agent', wait_for_window: false },
    });
    const sc = res.structuredContent as { ok: boolean; result: { workspace: string } };
    expect(sc.ok).toBe(true);
    expect(sc.result.workspace).toBe('name:agent');
    // the app must be placed on the agent workspace, quoted so the shell
    // does not split the title with a space
    const execCall = fake.received().find((r) => r.startsWith('dispatch exec'));
    expect(execCall).toBeTruthy();
    expect(execCall).toContain('[workspace name:agent silent]');
    expect(execCall).toContain("--title 'agent shell'");
    expect(execCall).not.toContain('--title agent shell');
  });

  // LAUNCH-01: numeric id form
  it('launch with numeric workspace id dispatches exec [workspace N]', async () => {
    const res = await client.callTool({
      name: 'launch',
      arguments: { command: 'kitty', workspace: 5, wait_for_window: false },
    });
    const sc = res.structuredContent as { ok: boolean; result: { workspace: string } };
    expect(sc.ok).toBe(true);
    expect(sc.result.workspace).toBe('5');
    const execCall = fake.received().find((r) => r.startsWith('dispatch exec'));
    expect(execCall).toContain('[workspace 5 silent]');
  });

  // LAUNCH-01: wait_for_window poll resolves the named workspace id
  it('launch with name:agent and wait_for_window matches a window on the resolved named workspace', async () => {
    // a named workspace resolves to a -1337-class id in the snapshot
    fake.respond['j/workspaces'] = JSON.stringify([
      { id: 1, name: '1', windows: 0 },
      { id: -1337, name: 'agent', windows: 1 },
    ]);
    fake.respond['j/clients'] = JSON.stringify([
      {
        address: '0x55dfd4972540', class: 'kitty', initialClass: 'kitty', title: 'agent shell', initialTitle: '', pid: 9001,
        at: [0, 0], size: [640, 480], workspace: { id: -1337, name: 'agent' }, floating: false, pseudo: false, monitor: 0,
        xwayland: false, pinned: false, fullscreen: false, fullscreenClient: 0, grouped: [], tags: [],
        swallowing: '0', focusHistoryID: 0, hidden: false, minimized: false, mapped: true, stableId: 'stable-kitty',
      },
    ]);
    const res = await client.callTool({
      name: 'launch',
      arguments: { command: 'kitty', workspace: 'name:agent', wait_for_window: true, timeout_ms: 3000 },
    });
    const sc = res.structuredContent as { ok: boolean; result: { window: string } };
    expect(sc.ok).toBe(true);
    expect(sc.result.window).toBe('0x55dfd4972540');
  });

  it('launch without workspace keeps the current behavior (no exec dispatch)', async () => {
    const res = await client.callTool({
      name: 'launch',
      arguments: { command: '/bin/true', wait_for_window: false },
    });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
    expect(fake.received().filter((r) => r.startsWith('dispatch exec'))).toHaveLength(0);
  });

  it('read_text_on_screen returns OCR text and word boxes in logical coordinates', async () => {
    // window 'gajim' at [960,0] size [960,1080], scale 1 → logical == pixel offset
    const res = await client.callTool({ name: 'read_text_on_screen', arguments: { target: 'window', window: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean; untrustedSource?: true; result: { text: string; words: { text: string; logical: { x: number; y: number } }[] } };
    expect(sc.ok).toBe(true);
    expect(sc.result.text).toContain('Save');
    // word "Save" at pixel (21,42) in the window at x=960 → logical x = 960+21
    expect(sc.result.words[0]!.text).toBe('Save');
    expect(sc.result.words[0]!.logical.x).toBe(960 + 21);
    // OCR content is untrusted observation (anti-prompt-injection provenance)
    expect(sc.untrustedSource).toBe(true);
  });

  it('get_state and list_windows mark window-title results as untrusted source', async () => {
    const gs = await client.callTool({ name: 'get_state', arguments: {} });
    const gssc = gs.structuredContent as { untrustedSource?: true };
    expect(gssc.untrustedSource).toBe(true);
    const lw = await client.callTool({ name: 'list_windows', arguments: {} });
    const lwsc = lw.structuredContent as { untrustedSource?: true };
    expect(lwsc.untrustedSource).toBe(true);
  });

  it('click_text finds text and clicks its center via sendclick when the plugin is loaded', async () => {
    fake.respond['plugin list'] = 'Plugin hyprland-mcp-click by Keylessboi:\n\tenabled: true';
    // "Save" word: pixel (21,42,42,10) in window at x=960,y=0 → center (960+21+21, 0+42+5)
    const res = await client.callTool({ name: 'click_text', arguments: { text: 'Save', window: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean; result: { x: number; y: number; address: string } };
    expect(sc.ok).toBe(true);
    expect(sc.result.x).toBe(960 + 21 + 21);
    expect(sc.result.y).toBe(0 + 42 + 5);
    const sendclick = fake.received().find((r) => r.startsWith('dispatch sendclick'));
    expect(sendclick).toBeTruthy();
    expect(sendclick).toContain(`x:${sc.result.x},y:${sc.result.y}`);
  });

  it('click_text falls back to movecursor+ydotool when the plugin is absent', async () => {
    fake.respond['plugin list'] = 'no plugins';
    const res = await client.callTool({ name: 'click_text', arguments: { text: 'Save', window: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
    expect(fake.received().filter((r) => r.startsWith('dispatch sendclick'))).toHaveLength(0);
    expect(fake.received().some((r) => r.startsWith('dispatch movecursor'))).toBe(true);
  });

  it('click_text errors with TEXT_NOT_FOUND when the text is absent', async () => {
    const res = await client.callTool({ name: 'click_text', arguments: { text: 'DefinitelyNotHere', window: 'gajim' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string } };
    expect(sc.error.code).toBe('TEXT_NOT_FOUND');
  });

  it('wait_for returns immediately when a window already exists', async () => {
    const res = await client.callTool({ name: 'wait_for', arguments: { window: 'gajim', timeout_ms: 2000 } });
    const sc = res.structuredContent as { ok: boolean; result: { matched: string } };
    expect(sc.ok).toBe(true);
    expect(sc.result.matched).toBe('window');
  });

  it('wait_for times out with WAIT_TIMEOUT when the condition never holds', async () => {
    const res = await client.callTool({ name: 'wait_for', arguments: { window: 'does-not-exist', timeout_ms: 200, poll_ms: 50 } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string } };
    expect(sc.error.code).toBe('WAIT_TIMEOUT');
  });

  it('window tool dispatches resize and move with address selectors', async () => {
    await client.callTool({ name: 'window', arguments: { target: 'gajim', action: 'resize', w: 800, h: 600 } });
    expect(fake.received().some((r) => r.startsWith('dispatch resizewindowpixel 800x600,address:0x55dfd4972540'))).toBe(true);
    await client.callTool({ name: 'window', arguments: { target: 'gajim', action: 'move', x: 100, y: 200 } });
    expect(fake.received().some((r) => r.startsWith('dispatch movewindowpixel 100,200,address:0x55dfd4972540'))).toBe(true);
    await client.callTool({ name: 'window', arguments: { target: 'gajim', action: 'fullscreen' } });
    expect(fake.received().some((r) => r.startsWith('dispatch fullscreen 1 address:0x55dfd4972540'))).toBe(true);
  });

  // P0b: denyClasses + windowScope enforced at resolveUnique (and kill)
  it('focus on a deny-listed class returns PERMISSION_DENIED with rule', async () => {
    setConfig({ denyClasses: ['gajim'] });
    const res = await client.callTool({ name: 'focus', arguments: { target: 'gajim' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error: { code: string }; rule?: string; windowClass?: string };
    expect(sc.error.code).toBe('PERMISSION_DENIED');
    expect(sc.rule).toBe('denyClasses');
    expect(sc.windowClass).toBe('org.gajim.Gajim');
    // and nothing reached the compositor
    expect(fake.received().filter((r) => r.startsWith('dispatch focuswindow'))).toHaveLength(0);
  });

  it('focus on a class outside windowScope returns PERMISSION_DENIED', async () => {
    setConfig({ windowScope: ['foot', 'kitty'] });
    const res = await client.callTool({ name: 'focus', arguments: { target: 'gajim' } });
    const sc = res.structuredContent as { error: { code: string }; rule?: string };
    expect(sc.error.code).toBe('PERMISSION_DENIED');
    expect(sc.rule).toBe('windowScope');
  });

  it('windowScope allows in-scope classes', async () => {
    setConfig({ windowScope: ['gajim'] });
    const res = await client.callTool({ name: 'focus', arguments: { target: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
    expect(fake.received().some((r) => r.startsWith('dispatch focuswindow address:0x55dfd4972540'))).toBe(true);
  });

  it('kill resolves pid to class and enforces denyClasses', async () => {
    setConfig({ denyClasses: ['gajim'] });
    const res = await client.callTool({ name: 'kill', arguments: { pid: 93753 } });
    const sc = res.structuredContent as { error: { code: string }; rule?: string };
    expect(sc.error.code).toBe('PERMISSION_DENIED');
    expect(sc.rule).toBe('denyClasses');
  });

  // P0e: health reports effective policy; strict exec fails closed
  it('health reports the effective policy surface', async () => {
    setConfig({ denyClasses: ['gajim'], windowScope: ['foot'], dispatchAllow: ['focuswindow'], readOnly: false, strict: false });
    const res = await client.callTool({ name: 'health', arguments: {} });
    const sc = res.structuredContent as {
      ok: boolean;
      result: {
        capabilities: Record<string, boolean>;
        toolsAllow: string[];
        dispatchAllow: string[];
        denyClasses: string[];
        windowScope: string[];
        readOnly: boolean;
        strict: boolean;
        auditPath: string;
        killSwitchFile: string;
        policyDrift: boolean;
      };
    };
    expect(sc.ok).toBe(true);
    expect(sc.result.denyClasses).toEqual(['gajim']);
    expect(sc.result.windowScope).toEqual(['foot']);
    expect(sc.result.dispatchAllow).toEqual(['focuswindow']);
    expect(sc.result.readOnly).toBe(false);
    expect(typeof sc.result.auditPath).toBe('string');
    expect(typeof sc.result.policyDrift).toBe('boolean');
  });

  it('strict mode refuses exec with empty prefixes (launch)', async () => {
    setConfig({ strict: true, execAllowPrefixes: [] });
    const res = await client.callTool({ name: 'launch', arguments: { command: 'firefox', wait_for_window: false } });
    const sc = res.structuredContent as { error: { code: string } };
    expect(sc.error.code).toBe('PERMISSION_DENIED');
  });

  it('strict mode still allows exec with matching prefixes', async () => {
    setConfig({ strict: true, execAllowPrefixes: ['/bin/true'] });
    const res = await client.callTool({ name: 'launch', arguments: { command: '/bin/true', wait_for_window: false } });
    const sc = res.structuredContent as { ok: boolean };
    expect(sc.ok).toBe(true);
  });

  // P0c: the gatedRegister chokepoint — caps, kill-switch, tools.allow/exclude, readOnly, audit
  it('capabilities.input=false denies input tools with rule', async () => {
    setConfig({ capabilities: { ...loadConfig().capabilities, input: false } });
    const res = await client.callTool({ name: 'input_type', arguments: { text: 'hi', target: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean; error: { code: string } | undefined; rule?: string };
    expect(sc.ok).toBe(false);
    expect(sc.error?.code).toBe('PERMISSION_DENIED');
    expect(sc.rule).toBe('capabilities.input');
    expect(inputFake.calls.filter((c) => c[0] === 'wtype')).toHaveLength(0);
  });

  it('capabilities.destructive=false denies close', async () => {
    setConfig({ capabilities: { ...loadConfig().capabilities, destructive: false } });
    const res = await client.callTool({ name: 'close', arguments: { target: 'gajim' } });
    const sc = res.structuredContent as { ok: boolean; error: { code: string } | undefined; rule?: string };
    expect(sc.ok).toBe(false);
    expect(sc.error?.code).toBe('PERMISSION_DENIED');
    expect(sc.rule).toBe('capabilities.destructive');
  });

  it('kill-switch file freezes mutators but not observers', async () => {
    const kill = path.join(os.tmpdir(), `hypr-stop-${Date.now()}`);
    fs.writeFileSync(kill, '');
    setConfig({ session: { ...loadConfig().session, killSwitchFile: kill } });
    const focus = await client.callTool({ name: 'focus', arguments: { target: 'gajim' } });
    const fsc = focus.structuredContent as { ok: boolean; error: { code: string } | undefined; rule?: string };
    expect(fsc.ok).toBe(false);
    expect(fsc.error?.code).toBe('PERMISSION_DENIED');
    expect(fsc.rule).toBe('killSwitch');
    // observers still answer
    const gs = await client.callTool({ name: 'get_state', arguments: {} });
    expect((gs.structuredContent as { ok: boolean }).ok).toBe(true);
    fs.rmSync(kill, { force: true });
  });

  it('tools.exclude hides dispatch from tools/list and denies calls', async () => {
    const c = await makeServer({ tools: { allow: [], exclude: ['dispatch'] } });
    // tools/list no longer advertises dispatch; a direct call is denied with a structured envelope
    const res = await c.callTool({ name: 'dispatch', arguments: { args: ['focuswindow', 'address:0x55dfd4972540'] } });
    const sc = res.structuredContent as { ok: boolean; error: { code: string } | undefined; rule?: string };
    expect(sc.ok).toBe(false);
    expect(sc.error?.code).toBe('PERMISSION_DENIED');
    expect(sc.rule).toBe('tools.exclude');
  });

  it('readOnly keeps observation tools and denies mutators', async () => {
    const c = await makeServer({ readOnly: true });
    const close = await c.callTool({ name: 'close', arguments: { target: 'gajim' } });
    const csc = close.structuredContent as { ok: boolean; error: { code: string } | undefined; rule?: string };
    expect(csc.ok).toBe(false);
    expect(csc.error?.code).toBe('PERMISSION_DENIED');
    expect(csc.rule).toBe('readOnly');
    const gs = await c.callTool({ name: 'get_state', arguments: {} });
    expect((gs.structuredContent as { ok: boolean }).ok).toBe(true);
  });

  it('audit log records a denial with rule', async () => {
    const auditPath = path.join(os.tmpdir(), `hypr-audit-${Date.now()}`, 'audit.jsonl');
    const c = await makeServer({ session: { ...loadConfig().session, auditPath }, capabilities: { ...loadConfig().capabilities, input: false } });
    await c.callTool({ name: 'input_click', arguments: { target: 'gajim' } }); // denied → denial line
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const denial = JSON.parse(lines[0]!) as { tool: string; denied: boolean; rule: string };
    expect(denial.tool).toBe('input_click');
    expect(denial.denied).toBe(true);
    expect(denial.rule).toBe('capabilities.input');
  });
});
