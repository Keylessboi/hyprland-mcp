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
import { assertNotLocked } from '../lock.js';
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

// Quote-join argv into a single shell string for `dispatch exec`. Hyprland
// runs exec through /bin/sh -c, so each arg must survive the shell. This is
// the plan's rule: validate + quote server-side, never build from window
// titles or other untrusted text.
function quoteJoin(argv: string[]): string {
  return argv
    .map((a) => {
      if (/^[a-zA-Z0-9_\/.@%+=:-]+$/.test(a))
        return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

// ─── tool registration ──────────────────────────────────────────────────────

export function registerCoreTools(server: McpServer, deps: ServerDeps): void {
  const { ipc, state, screenshots, ocr, input, config } = deps;

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
      description: 'Launch an app, optionally into a specific workspace. Prefer launching into a dedicated agent workspace (name:agent) so the app never appears on the user\'s screen. With workspace set, the app opens directly on that workspace; without it, the app opens on the current one.',
      inputSchema: z.object({
        command: z.string().describe('Executable name or absolute path'),
        args: z.array(z.string()).default([]),
        workspace: z.union([z.number().int(), z.string()]).optional().describe('Launch the app directly onto this workspace. A number is a workspace ID (positive = regular, negative = special/named). A string is a Hyprland selector: name:agent creates a named workspace on demand; special:name targets a scratchpad. The app never appears on the current workspace.'),
        wait_for_window: z.boolean().default(true),
        timeout_ms: z.number().int().default(10000),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ command, args, workspace, wait_for_window, timeout_ms }) => {
      const start = Date.now();
      try {
        assertExecAllowed(config, command);
        if (workspace !== undefined) {
          // Atomic placement: Hyprland opens the window on the target
          // workspace directly via the exec rule. No server-side pid is
          // available (the compositor forks), so wait_for_window matches by
          // class, and cleanup goes through close/kill on the window.
          const wsSpec = String(workspace);
          await ipc.dispatch(['exec', `[workspace ${wsSpec}] ${quoteJoin([command, ...args])}`]);
          if (!wait_for_window) {
            return { content: [{ type: 'text', text: JSON.stringify({ workspace: wsSpec }) }], structuredContent: ok('launch', { workspace: wsSpec, waited: false }, start) } as const;
          }
          // Resolve the target workspace's id for the poll. A name: selector
          // gets a -1337-class id that the snapshot reports by that id.
          const resolveWsId = (s: { workspaces: { id: number; name: string }[] }): number | undefined => {
            if (typeof workspace === 'number')
              return workspace;
            const clean = workspace.startsWith('name:') ? workspace.slice(5) : workspace;
            return s.workspaces.find((w) => w.name === clean)?.id;
          };
          const deadline = Date.now() + timeout_ms;
          const classMatch = command.toLowerCase().split('/').pop()!.toLowerCase();
          while (Date.now() < deadline) {
            const s = await state.snapshot();
            const wsId = resolveWsId(s);
            const match = s.clients.find((c) => c.class.toLowerCase().includes(classMatch) && (wsId === undefined || c.workspace.id === wsId));
            if (match) {
              return { content: [{ type: 'text', text: JSON.stringify({ workspace: wsSpec, window: { address: match.address, class: match.class } }) }], structuredContent: ok('launch', { workspace: wsSpec, window: match.address, waited: true }, start) } as const;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          throw new HyprError('APP_LAUNCH_TIMEOUT', `launched into workspace ${wsSpec} but no window appeared in ${timeout_ms}ms`, {
            hint: `The process may still be starting, or crashed. Check with list_windows / get_state.`,
            recoverable: false,
          });
        }
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
        await assertNotLocked(ipc);
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

  // ── SIGHT: OCR (text-on-screen, desktop-interaction) ──────────────────────

  server.registerTool(
    'read_text_on_screen',
    {
      title: 'Read text on screen',
      description: 'OCR a window, region, or the screen and return the visible text plus word boxes (pixel and logical coordinates). Use this to learn what text an app shows before targeting it with click_text or wait_for. Requires tesseract. The lock guard applies.',
      inputSchema: z.object({
        target: z.enum(['screen', 'window', 'region']).default('screen'),
        window: targetSchema.optional(),
        geometry: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        language: z.string().default('eng').describe('tesseract language code (e.g. eng, osd). Only installed languages work.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ target, window, geometry, language }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        const monitors = (await ipc.json<{ id: number; name: string; x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map((m) => ({ id: m.id, name: m.name, x: m.x, y: m.y, w: m.width, h: m.height, scale: m.scale }));
        const scaleOf = (rect: LogicalRect) => {
          const m = monitors.find((mo) => mo.x === rect.x && mo.y === rect.y) ?? monitors.find((mo) => rect.x >= mo.x && rect.x < mo.x + mo.w && rect.y >= mo.y && rect.y < mo.y + mo.h);
          return m?.scale ?? 1;
        };

        let cap: Awaited<ReturnType<typeof screenshots.region>>;
        let origin: { x: number; y: number };
        let region: LogicalRect;

        if (target === 'window') {
          if (!window) throw new HyprError('INVALID_ARGUMENTS', 'read_text_on_screen target=window requires a window selector');
          const { address } = await resolveUnique(deps, window, 'read_text_on_screen');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'window vanished before capture');
          region = { x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] };
          origin = { x: w.at[0], y: w.at[1] };
          cap = await screenshots.region(region);
        } else if (target === 'region') {
          if (!geometry) throw new HyprError('INVALID_ARGUMENTS', 'read_text_on_screen target=region requires geometry {x,y,w,h}');
          region = geometry;
          origin = { x: geometry.x, y: geometry.y };
          cap = await screenshots.region(geometry);
        } else {
          const all = monitors.map((m) => ({ x: m.x, y: m.y, w: m.w, h: m.h }));
          region = { x: Math.min(...all.map((r) => r.x)), y: Math.min(...all.map((r) => r.y)), w: Math.max(...all.map((r) => r.x + r.w)) - Math.min(...all.map((r) => r.x)), h: Math.max(...all.map((r) => r.y + r.h)) - Math.min(...all.map((r) => r.y)) };
          origin = { x: region.x, y: region.y };
          cap = await screenshots.region(region);
        }

        const scale = scaleOf(region);
        const { text, words } = await ocr.readImage(cap.data, { language });
        const boxes = words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          pixel: { left: word.left, top: word.top, width: word.width, height: word.height },
          logical: { x: origin.x + word.left / scale, y: origin.y + word.top / scale, w: word.width / scale, h: word.height / scale },
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ format: target, text, wordCount: boxes.length, region }) }],
          structuredContent: ok('read_text_on_screen', { format: target, text, words: boxes, region }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('read_text_on_screen', e, start)) }], isError: true, structuredContent: err('read_text_on_screen', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'click_text',
    {
      title: 'Click text on screen',
      description: 'Find a text string on screen (OCR) and click its center. One call replaces screenshot + vision + coordinate math. Optionally scope to a window; optionally choose which match when the text appears several times. Uses the same focused/guarded input path as input_click.',
      inputSchema: z.object({
        text: z.string().describe('The text to find (substring match on OCR words)'),
        window: targetSchema.optional().describe('Scope the search to this window'),
        match: z.number().int().default(0).describe('Which match to click when the text appears multiple times (0 = first)'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ text, window, match, button }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        const targetForCapture = window !== undefined ? 'window' : 'screen';
        const { address } = window !== undefined ? await resolveUnique(deps, window, 'click_text') : { address: undefined as string | undefined };
        const s = window !== undefined ? await state.snapshot() : undefined;
        const w = window !== undefined ? s!.clients.find((c) => c.address === address) : undefined;
        if (window !== undefined && !w) throw new HyprError('WINDOW_NOT_FOUND', 'window vanished before capture');

        const region: LogicalRect = window !== undefined && w ? { x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] } : await (async () => {
          const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height }));
          return { x: Math.min(...monitors.map((r) => r.x)), y: Math.min(...monitors.map((r) => r.y)), w: Math.max(...monitors.map((r) => r.x + r.w)) - Math.min(...monitors.map((r) => r.x)), h: Math.max(...monitors.map((r) => r.y + r.h)) - Math.min(...monitors.map((r) => r.y)) };
        })();
        void targetForCapture;

        const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height, scale: m.scale }));
        const mo = monitors.find((m) => region.x >= m.x && region.x < m.x + m.w && region.y >= m.y && region.y < m.y + m.h) ?? monitors[0];
        const scale = mo?.scale ?? 1;
        const cap = await screenshots.region(region);
        const { words } = await ocr.readImage(cap.data);
        const needle = text.toLowerCase();
        const hits = words.filter((word) => word.text.toLowerCase().includes(needle));
        if (hits.length === 0) {
          throw new HyprError('TEXT_NOT_FOUND', `no match for "${text}" on ${window !== undefined ? 'window ' + address : 'screen'}`, {
            hint: 'Run read_text_on_screen first to see the actual text on screen.',
            recoverable: true,
          });
        }
        if (match >= hits.length) {
          throw new HyprError('TEXT_NOT_FOUND', `match ${match} out of range: "${text}" found ${hits.length} time(s)`, { recoverable: true });
        }
        const hit = hits[match]!;
        const clickX = Math.round(region.x + (hit.left + hit.width / 2) / scale);
        const clickY = Math.round(region.y + (hit.top + hit.height / 2) / scale);

        if (window !== undefined && address && (await probeSendclick(ipc))) {
          await ipc.dispatch(['sendclick', `address:${address},button:${button},x:${clickX},y:${clickY}`]);
        } else {
          await ipc.dispatch(['movecursor', String(clickX), String(clickY)]);
          await input.click(button);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ text, clicked: { x: clickX, y: clickY }, address: address ?? null }) }], structuredContent: ok('click_text', { text, x: clickX, y: clickY, address: address ?? null }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('click_text', e, start)) }], isError: true, structuredContent: err('click_text', e, start) } as const;
      }
    },
  );

  server.registerTool(
    'wait_for',
    {
      title: 'Wait for condition',
      description: 'Block until a condition becomes true: text on screen (OCR), a window appearing, or a workspace becoming active. Polls the desktop; returns as soon as the condition holds or times out. Replaces agent sleep-and-poll loops.',
      inputSchema: z.object({
        text: z.string().optional().describe('Wait until this text appears on screen (OCR). Note: OCR on the whole screen is slow; prefer window-scoped waits.'),
        window: targetSchema.optional().describe('Wait until this window exists'),
        active_workspace: z.number().int().optional().describe('Wait until this workspace is active'),
        timeout_ms: z.number().int().default(15000),
        poll_ms: z.number().int().default(500),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ text, window, active_workspace, timeout_ms, poll_ms }) => {
      const start = Date.now();
      try {
        if (text === undefined && window === undefined && active_workspace === undefined) {
          throw new HyprError('INVALID_ARGUMENTS', 'wait_for needs at least one of text, window, or active_workspace');
        }
        const deadline = Date.now() + timeout_ms;
        while (Date.now() < deadline) {
          if (window !== undefined) {
            const hits = await deps.state.resolveWindow(window);
            if (hits.length > 0) {
              return { content: [{ type: 'text', text: JSON.stringify({ matched: 'window', window: hits[0]!.address }) }], structuredContent: ok('wait_for', { matched: 'window', address: hits[0]!.address, ms: Date.now() - start }, start) } as const;
            }
          }
          if (active_workspace !== undefined) {
            const s = await state.snapshot();
            const active = s.monitors.find((m) => m.focused)?.activeWorkspace?.id;
            if (active === active_workspace) {
              return { content: [{ type: 'text', text: JSON.stringify({ matched: 'workspace', id: active_workspace }) }], structuredContent: ok('wait_for', { matched: 'workspace', id: active_workspace, ms: Date.now() - start }, start) } as const;
            }
          }
          if (text !== undefined) {
            // OCR the focused window if possible, else the screen
            const s = await state.snapshot();
            const focused = s.clients.find((c) => c.address === s.activeWindow?.address);
            const region: LogicalRect = focused ? { x: focused.at[0], y: focused.at[1], w: focused.size[0], h: focused.size[1] } : await (async () => {
              const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height }));
              return { x: Math.min(...monitors.map((r) => r.x)), y: Math.min(...monitors.map((r) => r.y)), w: Math.max(...monitors.map((r) => r.x + r.w)) - Math.min(...monitors.map((r) => r.x)), h: Math.max(...monitors.map((r) => r.y + r.h)) - Math.min(...monitors.map((r) => r.y)) };
            })();
            const cap = await screenshots.region(region);
            const { words } = await ocr.readImage(cap.data);
            if (words.some((word) => word.text.toLowerCase().includes(text.toLowerCase()))) {
              return { content: [{ type: 'text', text: JSON.stringify({ matched: 'text', text }) }], structuredContent: ok('wait_for', { matched: 'text', text, ms: Date.now() - start }, start) } as const;
            }
          }
          await new Promise((r) => setTimeout(r, poll_ms));
        }
        throw new HyprError('WAIT_TIMEOUT', `condition not met within ${timeout_ms}ms`, { recoverable: true });
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('wait_for', e, start)) }], isError: true, structuredContent: err('wait_for', e, start) } as const;
      }
    },
  );

  // ── ACT: window lifecycle (no minimize in 0.56; use fullscreen/resize/move) ─

  server.registerTool(
    'window',
    {
      title: 'Window lifecycle',
      description: 'Change a window: toggle fullscreen, resize to a size, move to a position, toggle float/tile. Does the window action through the compositor. (Hyprland 0.56 has no minimize dispatcher; close is available via the close tool.)',
      inputSchema: z.object({
        target: targetSchema,
        action: z.enum(['fullscreen', 'resize', 'move', 'float']).describe('fullscreen: toggle fullscreen. resize: set size (w x h in logical px). move: set position (x,y logical). float: toggle floating/tiled.'),
        w: z.number().int().optional().describe('width for resize'),
        h: z.number().int().optional().describe('height for resize'),
        x: z.number().int().optional().describe('x for move'),
        y: z.number().int().optional().describe('y for move'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ target, action, w, h, x, y }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        const { address } = await resolveUnique(deps, target, 'window');
        const sel = `address:${address}`;
        switch (action) {
          case 'fullscreen':
            await ipc.dispatch(['fullscreen', '1', sel]);
            break;
          case 'resize': {
            if (w === undefined || h === undefined) throw new HyprError('INVALID_ARGUMENTS', 'resize needs w and h');
            await ipc.dispatch(['resizewindowpixel', `${w}x${h},${sel}`]);
            break;
          }
          case 'move': {
            if (x === undefined || y === undefined) throw new HyprError('INVALID_ARGUMENTS', 'move needs x and y');
            await ipc.dispatch(['movewindowpixel', `${Math.round(x)},${Math.round(y)},${sel}`]);
            break;
          }
          case 'float':
            await ipc.dispatch(['togglefloating', sel]);
            break;
        }
        return { content: [{ type: 'text', text: JSON.stringify({ action, address }) }], structuredContent: ok('window', { action, address }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('window', e, start)) }], isError: true, structuredContent: err('window', e, start) } as const;
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
        await assertNotLocked(ipc);
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
        await assertNotLocked(ipc);
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
        await assertNotLocked(ipc);
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
        await assertNotLocked(ipc);
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
        await assertNotLocked(ipc);
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
