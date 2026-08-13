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
    serverVersion: 'test',
  };

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
    expect(execCall).toContain('[workspace name:agent]');
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
    expect(execCall).toContain('[workspace 5]');
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
    const sc = res.structuredContent as { ok: boolean; result: { text: string; words: { text: string; logical: { x: number; y: number } }[] } };
    expect(sc.ok).toBe(true);
    expect(sc.result.text).toContain('Save');
    // word "Save" at pixel (21,42) in the window at x=960 → logical x = 960+21
    expect(sc.result.words[0]!.text).toBe('Save');
    expect(sc.result.words[0]!.logical.x).toBe(960 + 21);
  });

  it('click_text finds text and clicks its center via sendclick', async () => {
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
});
