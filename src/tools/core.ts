/**
 * Core tool surface (plan §8 — 14 tools, observe/act separated).
 *
 * Every handler: validate → security gate → act → fresh state → envelope.
 * Mutations poll-verify their own effect where a race is possible.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { spawnDetached, runCommand } from '../index.js';
import { HyprError, err, ok } from '../types.js';
import { assertNotDenied, assertExecAllowed } from '../security.js';
import { LogicalRect } from '../geometry.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// ─── window addressing ──────────────────────────────────────────────────────

const targetSchema = z.union([z.string(), z.number()]).describe('Window: address (0x…), class, title, or pid');

async function resolveUnique(deps: ServerDeps, target: string | number, action: string): Promise<{ address: string; window: import('../types.js').HyprWindow }> {
  const hits = await deps.state.resolveWindow(target);
  if (hits.length === 0) {
    throw new HyprError('WINDOW_NOT_FOUND', `no window matches "${target}"`, {
      hint: 'Try list_windows to see what is open.',
    });
  }
  if (hits.length > 1) {
    const candidates = hits.map((w) => `${w.class} (${w.address})`).join(', ');
    throw new HyprError('WINDOW_AMBIGUOUS', `"${target}" matches ${hits.length} windows: ${candidates}`, {
      hint: 'Use the exact address or class to disambiguate.',
    });
  }
  const w = hits[0]!;
  return { address: w.address, window: w };
}

const wsIdSchema = z.number().int().describe('Workspace id (negative = special workspace)');

// Write a capture to config.screenshotDir and return its absolute path. The
// file lets a text-only model hand the image to a vision subagent via `read`;
// the tool also keeps the inline image for vision-capable models.
async function writeScreenshot(dir: string, format: string, addressOrTag: string, data: Buffer, mime: string): Promise<string> {
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = addressOrTag.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(dir, `${stamp}_${format}${tag ? '_' + tag : ''}.${ext}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, data);
  return file;
}

// Cached probe: is the hyprland-mcp-click plugin loaded? When it is, the
// server can collapse an overlay click into one atomic `sendclick` dispatch
// instead of 4 roundtrips + a sleep + ydotool. Cached per ipc instance for the
// lifetime of the process (plugins rarely hot-load mid-session).
const sendclickCache = new WeakMap<object, boolean>();

async function probeSendclick(ipc: { request: (req: string) => Promise<string> }): Promise<boolean> {
  const cached = sendclickCache.get(ipc);
  if (cached !== undefined)
    return cached;
  let available = false;
  try {
    const list = await ipc.request('plugin list');
    available = list.includes('hyprland-mcp-click');
  } catch {
    available = false;
  }
  sendclickCache.set(ipc, available);
  return available;
}

// ─── tool registration ──────────────────────────────────────────────────────

export function registerCoreTools(server: McpServer, deps: ServerDeps): void {
  const { ipc, state, screenshots, input, config } = deps;

  // ── ORIENT ────────────────────────────────────────────────────────────────

  server.registerTool(
    'get_state',
    {
      title: 'Get desktop state',
      description:
        'Snapshot of the desktop: monitors, workspaces, all windows (incl. background/special-workspace), focused window, cursor position. The orient call — always start here.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const start = Date.now();
      try {
        const s = await state.snapshot();
        return {
          content: [{ type: 'text', text: JSON.stringify({
            version: s.version,
            activeWindow: s.activeWindow ? { address: s.activeWindow.address, class: s.activeWindow.class, title: s.activeWindow.title, workspace: s.activeWindow.workspace.id } : null,
            cursorpos: s.cursorpos,
            monitors: s.monitors.map((m) => ({ name: m.name, x: m.x, y: m.y, w: m.width, h: m.height, scale: m.scale, focused: m.focused, dpmsStatus: m.dpmsStatus })),
            workspaces: s.workspaces.map((w) => ({ id: w.id, name: w.name, windows: w.windows })),
            windows: s.clients.map((c) => ({ address: c.address, class: c.class, title: c.title, pid: c.pid, workspace: c.workspace.id, xwayland: c.xwayland, hidden: c.hidden, minimized: c.minimized, at: c.at, size: c.size, focused: s.activeWindow?.address === c.address })),
          }, null, 2) },
        ], structuredContent: ok('get_state', { windowCount: s.clients.length }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('get_state', e, start)) }], isError: true, structuredContent: err('get_state', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'list_windows',
    {
      title: 'List windows',
      description: 'All windows with class/title/pid/workspace/geometry — including background and special-workspace windows. Pass a filter substring to narrow.',
      inputSchema: z.object({ filter: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ filter }) => {
      const start = Date.now();
      try {
        const s = await state.snapshot();
        let wins = s.clients;
        if (filter) {
          const q = filter.toLowerCase();
          wins = wins.filter((c) => c.class.toLowerCase().includes(q) || c.title.toLowerCase().includes(q));
        }
        const list = wins.map((c) => ({ address: c.address, class: c.class, title: c.title, pid: c.pid, workspace: c.workspace.id, at: c.at, size: c.size }));
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }], structuredContent: ok('list_windows', { count: list.length, windows: list }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('list_windows', e, start)) }], isError: true, structuredContent: err('list_windows', e, start) } as const;
      }
    },
  );

  // ── ACT ───────────────────────────────────────────────────────────────────

  server.registerTool(
    'launch',
    {
      title: 'Launch app',
      description: 'Launch an app as a detached child with the session environment, optionally waiting for its window. Returns the real pid (process group) — never the surface pid.',
      inputSchema: z.object({
        command: z.string().describe('Executable name or absolute path'),
        args: z.array(z.string()).default([]),
        wait_for_window: z.boolean().default(true),
        timeout_ms: z.number().int().default(10000),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ command, args, wait_for_window, timeout_ms }) => {
      const start = Date.now();
      try {
        assertExecAllowed(config, command);
        const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE ?? '';
        const env = {
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
          HYPRLAND_INSTANCE_SIGNATURE: sig,
        };
        const { pid } = spawnDetached(command, args, env);
        if (!wait_for_window) {
          return { content: [{ type: 'text', text: JSON.stringify({ pid }) }], structuredContent: ok('launch', { pid, waited: false }, start) } as const;
        }
        // poll clients for a new window whose pid group matches
        const deadline = Date.now() + timeout_ms;
        let found: { address: string; class: string } | null = null;
        while (Date.now() < deadline) {
          const s = await state.snapshot();
          const match = s.clients.find((c) => c.pid === pid || c.class.toLowerCase().includes(command.toLowerCase().split('/').pop()!.toLowerCase()));
          if (match) {
            found = { address: match.address, class: match.class };
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (!found) {
          throw new HyprError('APP_LAUNCH_TIMEOUT', `launched pid ${pid} but no window appeared in ${timeout_ms}ms`, {
            hint: `The process may still be starting, or crashed. Check with list_windows / get_state. pid=${pid}`,
            recoverable: false,
          });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ pid, window: found }) }], structuredContent: ok('launch', { pid, window: found, waited: true }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('launch', e, start)) }], isError: true, structuredContent: err('launch', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'focus',
    {
      title: 'Focus window',
      description: 'Bring a window to the foreground and focus it. Accepts address, class, title, or pid; ambiguous matches are rejected.',
      inputSchema: z.object({ target: targetSchema }),
      annotations: { destructiveHint: true },
    },
    async ({ target }) => {
      const start = Date.now();
      try {
        const { address } = await resolveUnique(deps, target, 'focus');
        await ipc.dispatch(['focuswindow', `address:${address}`]);
        return { content: [{ type: 'text', text: JSON.stringify({ focused: address }) }], structuredContent: ok('focus', { focused: address }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('focus', e, start)) }], isError: true, structuredContent: err('focus', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'close',
    {
      title: 'Close window',
      description: 'Graceful close (WM close). Destructive.',
      inputSchema: z.object({ target: targetSchema }),
      annotations: { destructiveHint: true },
    },
    async ({ target }) => {
      const start = Date.now();
      try {
        const { address } = await resolveUnique(deps, target, 'close');
        await ipc.dispatch(['closewindow', `address:${address}`]);
        return { content: [{ type: 'text', text: JSON.stringify({ closed: address }) }], structuredContent: ok('close', { closed: address }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('close', e, start)) }], isError: true, structuredContent: err('close', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'kill',
    {
      title: 'Kill window',
      description: 'Kill a window by pid (or address). Uses SIGTERM then SIGKILL after grace. Destructive.',
      inputSchema: z.object({ pid: z.number().int().describe('Process pid — from list_windows/get_state') }),
      annotations: { destructiveHint: true },
    },
    async ({ pid }) => {
      const start = Date.now();
      try {
        await runCommand('kill', [String(pid)]);
        await new Promise((r) => setTimeout(r, 800));
        const alive = await runCommand('kill', ['-0', String(pid)]);
        if (alive.code === 0) {
          await runCommand('kill', ['-9', String(pid)]);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ pid, killed: true }) }], structuredContent: ok('kill', { pid }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('kill', e, start)) }], isError: true, structuredContent: err('kill', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'workspace',
    {
      title: 'Switch workspace',
      description: 'Switch to a workspace by id, or move a window to a workspace without switching view (silent).',
      inputSchema: z.object({
        id: wsIdSchema,
        window: targetSchema.optional().describe('If given, moves this window to the workspace silently instead of switching'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ id, window: target }) => {
      const start = Date.now();
      try {
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'workspace');
          await ipc.dispatch(['movetoworkspacesilent', String(id), `address:${address}`]);
          return { content: [{ type: 'text', text: JSON.stringify({ moved: address, to: id }) }], structuredContent: ok('workspace', { moved: address, to: id }, start) } as const;
        }
        await ipc.dispatch(['workspace', String(id)]);
        return { content: [{ type: 'text', text: JSON.stringify({ switched: id }) }], structuredContent: ok('workspace', { switched: id }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('workspace', e, start)) }], isError: true, structuredContent: err('workspace', e, start) } as const;
      }
    },
  );

  // ── SIGHT ─────────────────────────────────────────────────────────────────

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture the screen, a monitor, a window, or a region. Window capture prefers grim -T (occluded windows, zero perturbation) with geometry-crop fallback. Returns the image as inline MCP content plus a file path (for a vision subagent) and coordinate mapping. NEVER run grim or slurp yourself: this tool is the only sanctioned capture path — it handles occluded windows and never disturbs the app.',
      inputSchema: z.object({
        target: z.enum(['screen', 'window', 'region']).default('screen'),
        window: targetSchema.optional(),
        geometry: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        jpeg: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ target, window, geometry, jpeg }) => {
      const start = Date.now();
      try {
        const monitors = (await ipc.json<{ id: number; name: string; x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, w: m.width, h: m.height, scale: m.scale }));
        const geo: LogicalRect[] = monitors.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h }));
        void geo;

        if (target === 'window') {
          if (!window) throw new HyprError('INVALID_ARGUMENTS', 'screenshot target=window requires a window selector');
          const { address } = await resolveUnique(deps, window, 'screenshot');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'window vanished before capture');
          const monitorGeoms = monitors.map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, w: m.w, h: m.h, scale: m.scale }));
          if (w.stableId) {
            try {
              const cap = await screenshots.toplevel(w.stableId);
              const b64 = cap.data.toString('base64');
              const file = await writeScreenshot(config.screenshotDir, 'toplevel', address, cap.data, cap.mime);
              return {
                content: [
                  { type: 'text', text: JSON.stringify({ format: 'toplevel', address, stableId: w.stableId, empty: cap.empty, region: w.at.concat(w.size), file }) },
                  { type: 'image', data: b64, mimeType: cap.mime },
                ],
                structuredContent: ok('screenshot', { format: 'toplevel', address, geometry: { at: w.at, size: w.size }, empty: cap.empty, file }, start),
              } as const;
            } catch {
              // fall through to geometry crop
            }
          }
          const rect: LogicalRect = { x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] };
          const cap = await screenshots.region(rect, { jpeg });
          const b64 = cap.data.toString('base64');
          const mime = cap.mime;
          const file = await writeScreenshot(config.screenshotDir, 'window', address, cap.data, mime);
          return {
            content: [
              { type: 'text', text: JSON.stringify({ format: 'region', address, geometry: rect, empty: cap.empty, file }) },
              { type: 'image', data: b64, mimeType: mime },
            ],
            structuredContent: ok('screenshot', { format: 'region', address, geometry: rect, empty: cap.empty, file }, start),
          } as const;
        }

        if (target === 'region') {
          if (!geometry) throw new HyprError('INVALID_ARGUMENTS', 'screenshot target=region requires geometry {x,y,w,h}');
          const cap = await screenshots.region(geometry, { jpeg });
          const file = await writeScreenshot(config.screenshotDir, 'region', '', cap.data, cap.mime);
          return {
            content: [
              { type: 'text', text: JSON.stringify({ format: 'region', geometry, empty: cap.empty, file }) },
              { type: 'image', data: cap.data.toString('base64'), mimeType: cap.mime },
            ],
            structuredContent: ok('screenshot', { format: 'region', geometry, empty: cap.empty, file }, start),
          } as const;
        }

        // screen = union of monitors
        const all = monitors.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h }));
        const minX = Math.min(...all.map((r) => r.x));
        const minY = Math.min(...all.map((r) => r.y));
        const maxX = Math.max(...all.map((r) => r.x + r.w));
        const maxY = Math.max(...all.map((r) => r.y + r.h));
        const cap = await screenshots.region({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, { jpeg });
        const file = await writeScreenshot(config.screenshotDir, 'screen', '', cap.data, cap.mime);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ format: 'screen', geometry: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, empty: cap.empty, file }) },
            { type: 'image', data: cap.data.toString('base64'), mimeType: cap.mime },
          ],
          structuredContent: ok('screenshot', { format: 'screen', empty: cap.empty, file }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('screenshot', e, start)) }], isError: true, structuredContent: err('screenshot', e, start) } as const;
      }
    },
  );

  // ── INPUT (focus-guarded; the safety core) ────────────────────────────────

  server.registerTool(
    'input_click',
    {
      title: 'Click mouse',
      description: 'Move the cursor to a coordinate and click. With a target window, clicks the center of that window. If the window is on a non-active workspace, toggles the special workspace overlay transparently (under 1s, workspace state preserved). Pass via_overlay: false to disable auto-overlay. NEVER use ydotool or hyprctl dispatch movecursor yourself: this tool is focus-guarded and workspace-safe.',
      inputSchema: z.object({
        x: z.number().optional().describe('Logical coordinate x (if no target)'),
        y: z.number().optional().describe('Logical coordinate y (if no target)'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
        target: targetSchema.optional(),
        via_overlay: z.boolean().default(true).describe('If target is on another workspace, use special workspace overlay to make it visible'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ x, y, button, target, via_overlay }) => {
      const start = Date.now();
      try {
        // Fast path: with the hyprland-mcp-click plugin loaded, a single atomic
        // `sendclick` dispatch handles both visible and hidden windows (flash-free
        // overlay, workspace restore, no ydotool). The plugin clicks the window
        // center; via_overlay:false keeps the legacy behavior instead.
        if (target !== undefined && via_overlay && (await probeSendclick(ipc))) {
          const { address } = await resolveUnique(deps, target, 'input_click');
          await ipc.dispatch(['sendclick', `address:${address},button:${button}`]);
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          const cx = w ? Math.round(w.at[0] + w.size[0] / 2) : undefined;
          const cy = w ? Math.round(w.at[1] + w.size[1] / 2) : undefined;
          return { content: [{ type: 'text', text: JSON.stringify({ x: cx, y: cy, button, address, plugin: true }) }], structuredContent: ok('input_click', { x: cx, y: cy, button, plugin: true }, start) } as const;
        }
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_click');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'target window vanished');
          const cx = Math.round(w.at[0] + w.size[0] / 2);
          const cy = Math.round(w.at[1] + w.size[1] / 2);

          const activeWs = s.monitors.find((m) => m.focused)?.activeWorkspace?.id;
          const onActive = activeWs !== undefined && w.workspace.id === activeWs;
          const needsOverlay = via_overlay && !onActive;
          const origWs = w.workspace.id;

          if (needsOverlay) {
            await ipc.dispatch(['movetoworkspacesilent', 'special:mcp-click', `address:${address}`]);
            await ipc.dispatch(['togglespecialworkspace', 'mcp-click']);
          }
          await ipc.dispatch(['focuswindow', `address:${address}`]);
          await new Promise((r) => setTimeout(r, 200));
          await input.moveCursor(cx, cy);
          await input.click(button);

          if (needsOverlay) {
            await ipc.dispatch(['togglespecialworkspace', 'mcp-click']);
            await ipc.dispatch(['movetoworkspacesilent', String(origWs), `address:${address}`]);
          }
          return { content: [{ type: 'text', text: JSON.stringify({ x: cx, y: cy, button, address, overlay: needsOverlay }) }], structuredContent: ok('input_click', { x: cx, y: cy, button, overlay: needsOverlay }, start) } as const;
        }
        const clickX = x ?? 0;
        const clickY = y ?? 0;
        await input.moveCursor(Math.round(clickX), Math.round(clickY));
        await input.click(button);
        return { content: [{ type: 'text', text: JSON.stringify({ x: clickX, y: clickY, button }) }], structuredContent: ok('input_click', { x: clickX, y: clickY, button }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_click', e, start)) }], isError: true, structuredContent: err('input_click', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'input_type',
    {
      title: 'Type text',
      description: 'Type ASCII text into the focused window via wtype. Unicode/CJK requires input_paste. Focus guard applies. NEVER run wtype yourself: this tool verifies focus first so input cannot go to the wrong window.',
      inputSchema: z.object({ text: z.string(), target: targetSchema.optional() }),
      annotations: { destructiveHint: true },
    },
    async ({ text, target }) => {
      const start = Date.now();
      try {
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_type');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'target window vanished');
          // ensure focused — focus guard will verify
          await ipc.dispatch(['focuswindow', `address:${address}`]);
          await new Promise((r) => setTimeout(r, 150));
          await input.typeText(text, address);
        } else {
          await input.typeText(text);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ typed: text.length, chars: text.length }) }], structuredContent: ok('input_type', { chars: text.length }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_type', e, start)) }], isError: true, structuredContent: err('input_type', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'input_key',
    {
      title: 'Send key chord',
      description: 'Send a key chord (e.g. ctrl+alt+t) to the focused window, or per-window via sendshortcut without focus change (probe-gated).',
      inputSchema: z.object({
        chord: z.string(),
        target: targetSchema.optional().describe('If given, sendshortcut to this window without stealing focus'),
        mods: z.array(z.string()).optional().describe('Modifiers for sendshortcut mode: ["CTRL","SHIFT"]'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ chord, target, mods }) => {
      const start = Date.now();
      try {
        if (target !== undefined && mods) {
          const { address } = await resolveUnique(deps, target, 'input_key');
          const key = chord.toLowerCase();
          await input.sendShortcutToWindow(mods, key, address);
          return { content: [{ type: 'text', text: JSON.stringify({ mode: 'sendshortcut', window: address, chord }) }], structuredContent: ok('input_key', { mode: 'sendshortcut', chord }, start) } as const;
        }
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_key');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'target window vanished');
          await ipc.dispatch(['focuswindow', `address:${address}`]);
          await new Promise((r) => setTimeout(r, 150));
          await input.keyChord(chord, address);
          return { content: [{ type: 'text', text: JSON.stringify({ mode: 'focused', window: address, chord }) }], structuredContent: ok('input_key', { mode: 'focused', chord }, start) } as const;
        }
        await input.keyChord(chord);
        return { content: [{ type: 'text', text: JSON.stringify({ mode: 'focused', chord }) }], structuredContent: ok('input_key', { mode: 'focused', chord }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_key', e, start)) }], isError: true, structuredContent: err('input_key', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'input_paste',
    {
      title: 'Paste text (Unicode path)',
      description: 'Paste text via wl-copy + Ctrl+V. With a target window, uses sendshortcut (no focus steal — works on background windows). Without target, pastes into the currently focused window. Permission-gated. NEVER run wl-copy or wl-paste yourself: this tool is focus-guarded and gated.',
      inputSchema: z.object({ text: z.string(), target: targetSchema.optional() }),
      annotations: { destructiveHint: true },
    },
    async ({ text, target }) => {
      const start = Date.now();
      try {
        if (!config.allowClipboardPaste) {
          throw new HyprError('PERMISSION_DENIED', 'clipboard paste disabled in config');
        }
        await runCommand('wl-copy', ['--', text]);
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_paste');
          await input.sendShortcutToWindow(['CTRL'], 'V', address);
          return { content: [{ type: 'text', text: JSON.stringify({ pasted: text.length, mode: 'sendshortcut', window: address }) }], structuredContent: ok('input_paste', { chars: text.length, mode: 'sendshortcut' }, start) } as const;
        }
        await input.keyChord('ctrl+v');
        return { content: [{ type: 'text', text: JSON.stringify({ pasted: text.length, mode: 'focused' }) }], structuredContent: ok('input_paste', { chars: text.length, mode: 'focused' }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_paste', e, start)) }], isError: true, structuredContent: err('input_paste', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'input_drag',
    {
      title: 'Mouse drag',
      description: 'Drag the mouse from one coordinate to another. Uses movecursor for positioning + ydotool mousedown/move/mouseup.',
      inputSchema: z.object({
        start_x: z.number(), start_y: z.number(),
        end_x: z.number(), end_y: z.number(),
        button: z.enum(['left', 'right']).default('left'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ start_x, start_y, end_x, end_y, button }) => {
      const start = Date.now();
      try {
        await input.drag(start_x, start_y, end_x, end_y, button);
        return { content: [{ type: 'text', text: JSON.stringify({ dragged: true, from: [start_x, start_y], to: [end_x, end_y] }) }], structuredContent: ok('input_drag', { from: [start_x, start_y], to: [end_x, end_y] }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_drag', e, start)) }], isError: true, structuredContent: err('input_drag', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'clipboard_read',
    {
      title: 'Read clipboard',
      description: 'Read the clipboard text via wl-paste. Permission-gated. The clipboard may contain secrets.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const start = Date.now();
      try {
        const out = await runCommand('wl-paste', [], { timeoutMs: 2000 });
        const text = out.stdout.trim();
        return { content: [{ type: 'text', text: text }], structuredContent: ok('clipboard_read', { length: text.length }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('clipboard_read', e, start)) }], isError: true, structuredContent: err('clipboard_read', e, start) } as const;
      }
    },
  );

  // ── ESCAPE HATCH ──────────────────────────────────────────────────────────

  server.registerTool(
    'dispatch',
    {
      title: 'Hyprland dispatch (advanced)',
      description: 'Raw hyprctl dispatch passthrough for the 80% of subcommands not wrapped. ADVANCED — arguments are validated argv, never shell strings. Gated.',
      inputSchema: z.object({ args: z.array(z.string()).min(1) }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ args }) => {
      const start = Date.now();
      try {
        await ipc.dispatch(args);
        return { content: [{ type: 'text', text: JSON.stringify({ dispatched: args.join(' ') }) }], structuredContent: ok('dispatch', { args }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('dispatch', e, start)) }], isError: true, structuredContent: err('dispatch', e, start) } as const;
      }
    },
  );

  // ── HEALTH ────────────────────────────────────────────────────────────────

  server.registerTool(
    'health',
    {
      title: 'Server health & capabilities',
      description: 'Runtime doctor: IPC reachability, version, tool capability matrix, deny-list. Agents call this to self-diagnose.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const start = Date.now();
      try {
        const s = await state.snapshot();
        return {
          content: [{ type: 'text', text: JSON.stringify({
            version: s.version,
            capabilities: config.capabilities,
            denyList: config.denyClasses,
            ydotool: config.capabilities.input,
          }, null, 2) }],
          structuredContent: ok('health', { version: s.version, capabilities: config.capabilities }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('health', e, start)) }], isError: true, structuredContent: err('health', e, start) } as const;
      }
    },
  );
}
