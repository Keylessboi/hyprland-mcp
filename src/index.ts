/**
 * Hyprland MCP server — entry point.
 *
 * stdio transport only (the opencode session is the auth boundary).
 * Tool surface: orient → act → input → sight (see plan §8).
 */
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { discoverInstance, toConfig } from './discovery.js';
import { HyprIpc } from './ipc.js';
import { HyprEventStream } from './events.js';
import { DesktopStateStore } from './state.js';
import { Screenshotter, RealCommandRunner } from './screenshot.js';
import { InputController, RealInputRunner, HyprFocusGuard } from './input.js';
import { loadConfig, assertNotDenied, assertExecAllowed } from './security.js';
import { monitorGeometry } from './geometry.js';
import { HyprError, err, ok } from './types.js';
import { spawn } from 'node:child_process';
import { registerCoreTools } from './tools/core.js';

export interface ServerDeps {
  ipc: HyprIpc;
  events: HyprEventStream;
  state: DesktopStateStore;
  screenshots: Screenshotter;
  input: InputController;
  config: ReturnType<typeof loadConfig>;
  serverVersion: string;
}

// Server-level instructions injected into the client's context at initialize.
// These are the hard rules every model using this server must follow. The
// server owns the desktop; direct shell access to compositor tools bypasses
// the safety contract (focus guard, deny-list, restore, capture ladder).
const SERVER_INSTRUCTIONS = `You are connected to the hyprland-mcp server. It owns the Hyprland desktop. Use its tools for ALL desktop access.

NEVER run any of these yourself in a shell:
- grim, grimblast, slurp (screenshots)
- hyprctl, hyprctl-json (desktop queries, dispatch, plugins)
- ydotool, wtype, wl-copy, wl-paste (input and clipboard)
- swaymsg, wlrctl, or any other Wayland/X11 control tool

The server's tools do all of this safely: focus-guarded input, deny-listed windows, workspace restore, and a capture ladder that never disturbs the app. If you shell out directly you bypass those guarantees.

When you need a screenshot, call the screenshot tool. It returns a file path in the 'file' field. To see the image with a text-only model, hand that path to a vision subagent which reads the file. Never capture with grim yourself.

WORK IN YOUR OWN WORKSPACE. The user is working on their workspace right now. Do not touch it.
- Do not switch the user's active workspace. Do not steal focus from the user's windows.
- Launch apps with the launch tool's workspace parameter, pointing at a dedicated agent workspace (name:agent). The app opens there directly and never appears on the user's screen. Prefer this over launching into the current workspace and moving afterward.
- Test the app there, screenshot it there, close it there. Return the workspace to a clean state when done.
- Only interact with a window on the user's workspace when the task explicitly requires it, and restore focus and workspace afterward.`;

export function buildServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: 'hyprland-mcp', version: deps.serverVersion },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerCoreTools(server, deps);
  return server;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const instance = discoverInstance({ overrideDir: config.socketDir });

  const ipc = new HyprIpc(toConfig(instance));
  // preflight: one round trip proves the instance is alive and ours
  await ipc.json<unknown>('monitors');

  const events = new HyprEventStream(toConfig(instance));
  const state = new DesktopStateStore(ipc);
  const monitors = (await ipc.json<{ id: number; name: string; x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map(monitorGeometry);
  const screenshots = new Screenshotter(new RealCommandRunner(), monitors);
  const input = new InputController(ipc, new RealInputRunner(), new HyprFocusGuard(ipc), {
    allowUnicodePaste: config.allowClipboardPaste,
  });

  const deps: ServerDeps = {
    ipc,
    events,
    state,
    screenshots,
    input,
    config,
    serverVersion: '0.1.0',
  };

  const server = buildServer(deps);
  events.start();

  const factory: McpServerFactory = () => server;
  await serveStdio(factory);
}

// ─── helpers shared by tools ────────────────────────────────────────────────

export function runCommand(
  bin: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    let out = '';
    let errText = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new HyprError('UNKNOWN', `${bin} timed out`, { recoverable: true }));
    }, opts.timeoutMs ?? 15_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      errText += d.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: out, stderr: errText, code });
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === 'ENOENT') {
        reject(new HyprError('MISSING_BINARY', `${bin} not found`, { hint: `Install ${bin}` }));
      } else {
        reject(new HyprError('UNKNOWN', `${bin} failed: ${e.message}`, { recoverable: true }));
      }
    });
  });
}

/** Direct child spawn with injected session env — the primary launch path. */
export function spawnDetached(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { pid: number } {
  const child = spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, ...env },
  });
  child.unref();
  return { pid: child.pid ?? -1 };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dist/index.js')) {
  main().catch((e) => {
    if (e instanceof HyprError) {
      console.error(`hyprland-mcp: ${e.code}: ${e.message}${e.hint ? ` — ${e.hint}` : ''}`);
    } else {
      console.error('hyprland-mcp: fatal', e);
    }
    process.exit(1);
  });
}
