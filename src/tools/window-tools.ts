/**
 * Window lifecycle tools — launch, focus, close, kill, workspace, window.
 *
 * Mutations poll-verify their own effect where a race is possible. Quote-join
 * server-side so `dispatch exec` never builds a shell string from untrusted
 * window titles or other text.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { spawnDetached, runCommand } from '../index.js';
import { HyprError, err, ok } from '../types.js';
import { assertExecAllowed } from '../security.js';
import { assertNotLocked } from '../lock.js';
import { resolveUnique, assertWindowAllowed, targetSchema, wsIdSchema } from './window-addressing.js';
import { gatedRegister, type ToolPolicy } from './guard.js';
import { LaunchRegistry, inProcessTree } from '../launches.js';

let sharedLaunches: LaunchRegistry | undefined;
function defaultLaunches(): LaunchRegistry {
  sharedLaunches ??= new LaunchRegistry();
  return sharedLaunches;
}

type GatedRegister = typeof gatedRegister;

/**
 * Is this client already on the workspace the caller asked for? Compares the
 * same selector forms `launch` accepts: "name:agent", "special:magic", or a
 * bare numeric id.
 */
export function onWorkspace(client: { workspace: { id: number; name: string } }, spec: string): boolean {
  const s = spec.trim();
  if (s.startsWith('name:')) return client.workspace.name === s.slice(5);
  if (s.startsWith('special:')) return client.workspace.name === s;
  if (/^-?\d+$/.test(s)) return client.workspace.id === Number(s);
  return client.workspace.name === s;
}


/** Quote-join argv into a single shell string for `dispatch exec`. Hyprland
 * runs exec through /bin/sh -c, so each arg must survive the shell. This is
 * the plan's rule: validate + quote server-side, never build from window
 * titles or other untrusted text. */
function quoteJoin(argv: string[]): string {
  return argv
    .map((a) => {
      if (/^[a-zA-Z0-9_\/.@%+=:-]+$/.test(a))
        return a;
      return `'${a.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}

export function registerWindowTools(server: McpServer, deps: ServerDeps, gatedRegister: GatedRegister): void {
  const { ipc, state, config } = deps;
  const launches = deps.launches ?? defaultLaunches();

  gatedRegister(
    server,
    deps,
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
    { caps: ['exec'], mutating: true },
    async ({ command, args, workspace, wait_for_window, timeout_ms }) => {
      const start = Date.now();
      try {
        assertExecAllowed(config, command);
        const wsSpec = workspace !== undefined ? String(workspace) : undefined;
        // Every launch runs under the recording wrapper (see launches.ts):
        // the app's pid, output and exit status stay readable via app_status.
        const { record, argv } = launches.prepare(command, args, wsSpec);
        if (wsSpec !== undefined) {
          // Atomic placement: Hyprland opens the window on the target
          // workspace directly via the exec rule; the rule follows the
          // window's parent chain, so the wrapper does not break it.
          // silent: open on the target workspace WITHOUT stealing focus or
          // switching the user's active workspace.
          await ipc.dispatch(['exec', `[workspace ${wsSpec} silent] ${quoteJoin(argv)}`]);
        } else {
          spawnDetached(argv[0]!, argv.slice(1), {
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
            HYPRLAND_INSTANCE_SIGNATURE: process.env.HYPRLAND_INSTANCE_SIGNATURE ?? '',
          });
        }
        const pid = await launches.waitForPid(record, wait_for_window ? 3000 : 1000);
        const base = { launch_id: record.id, pid, ...(wsSpec !== undefined ? { workspace: wsSpec } : {}) };
        if (!wait_for_window) {
          return { content: [{ type: 'text', text: JSON.stringify(base) }], structuredContent: ok('launch', { ...base, waited: false }, start) } as const;
        }
        // A named workspace resolves to a -1337-class id in the snapshot.
        const resolveWsId = (s: { workspaces: { id: number; name: string }[] }): number | undefined => {
          if (workspace === undefined) return undefined;
          if (typeof workspace === 'number') return workspace;
          const clean = workspace.startsWith('name:') ? workspace.slice(5) : workspace;
          return s.workspaces.find((w) => w.name === clean)?.id;
        };
        const deadline = Date.now() + timeout_ms;
        const classMatch = command.toLowerCase().split('/').pop()!;
        while (Date.now() < deadline) {
          const s = await state.snapshot();
          const wsId = resolveWsId(s);
          // Prefer the launched process tree; fall back to class (single-instance
          // apps hand the window to an existing process) — on the target
          // workspace when one was given.
          const match =
            (pid ? s.clients.find((c) => inProcessTree(c.pid, pid)) : undefined) ??
            s.clients.find((c) => c.class.toLowerCase().includes(classMatch) && (wsSpec === undefined ? true : wsId === undefined || c.workspace.id === wsId));
          if (match) {
            // Trust nothing about placement: a window on the user's screen is
            // the one outcome worth a second round trip to rule out, so check
            // where it actually landed and move it if the exec rule missed.
            if (wsSpec !== undefined && !onWorkspace(match, wsSpec)) {
              await ipc.dispatch(['movetoworkspacesilent', `${wsSpec},address:${match.address}`]);
            }
            const window = { address: match.address, class: match.class };
            return { content: [{ type: 'text', text: JSON.stringify({ ...base, window }) }], structuredContent: ok('launch', { ...base, window: wsSpec !== undefined ? match.address : window, waited: true }, start) } as const;
          }
          const st = launches.status(record, 4000);
          if (st.exit_code !== null) {
            throw new HyprError('APP_LAUNCH_TIMEOUT', `${command} exited with status ${st.exit_code} before opening a window`, {
              hint: `Output tail:\n${st.output || '(no output)'}\nFull record: app_status { launch_id: "${record.id}" }`,
              recoverable: false,
            });
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        throw new HyprError('APP_LAUNCH_TIMEOUT', `launched ${command} (pid ${pid ?? 'unknown'}) but no window appeared in ${timeout_ms}ms`, {
          hint: `It may still be starting, or be a CLI program. Check app_status { launch_id: "${record.id}" } for its output and exit code.`,
          recoverable: false,
        });
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('launch', e, start)) }], isError: true, structuredContent: err('launch', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'app_status',
    {
      title: 'Launched app status and output',
      description:
        'What happened to an app started with launch: running or exited, exit code (signal when killed), and the tail of its stdout+stderr. Call without launch_id to list recent launches. Use it after launch to catch crashes, warnings and log lines a window never shows.',
      inputSchema: z.object({
        launch_id: z.string().optional().describe('launch_id returned by launch'),
        tail_bytes: z.number().int().positive().max(1_000_000).default(16000).describe('How much of the end of the output to return'),
      }),
      annotations: { readOnlyHint: true },
    },
    { mutating: false, observation: true },
    async ({ launch_id, tail_bytes }) => {
      const start = Date.now();
      try {
        if (!launch_id) {
          const recent = launches.list().slice(0, 50).map((r) => {
            const st = launches.status(r, 0);
            return { launch_id: r.id, command: r.command, running: st.running, exit_code: st.exit_code, output_bytes: st.output_bytes, runtime_ms: st.runtime_ms };
          });
          return { content: [{ type: 'text', text: JSON.stringify({ launches: recent }, null, 2) }], structuredContent: ok('app_status', { launches: recent }, start) } as const;
        }
        const rec = launches.get(launch_id);
        if (!rec) throw new HyprError('WINDOW_NOT_FOUND', `no launch "${launch_id}"`, { hint: 'Call app_status without launch_id to list launches.', recoverable: false });
        const st = launches.status(rec, tail_bytes);
        return { content: [{ type: 'text', text: JSON.stringify(st, null, 2) }], structuredContent: ok('app_status', st, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('app_status', e, start)) }], isError: true, structuredContent: err('app_status', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'focus',
    {
      title: 'Focus window',
      description: 'Bring a window to the foreground and focus it. Accepts address, class, title, or pid; ambiguous matches are rejected.',
      inputSchema: z.object({ target: targetSchema }),
      annotations: { destructiveHint: true },
    },
    { mutating: true, windowTouching: true },
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

  gatedRegister(
    server,
    deps,
    'close',
    {
      title: 'Close window',
      description: 'Graceful close (WM close). Destructive.',
      inputSchema: z.object({ target: targetSchema }),
      annotations: { destructiveHint: true },
    },
    { caps: ['destructive'], mutating: true, windowTouching: true },
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

  gatedRegister(
    server,
    deps,
    'kill',
    {
      title: 'Kill window',
      description: 'Kill a window by pid (or address). Uses SIGTERM then SIGKILL after grace. Destructive.',
      inputSchema: z.object({ pid: z.number().int().describe('Process pid — from list_windows/get_state') }),
      annotations: { destructiveHint: true },
    },
    { caps: ['destructive'], mutating: true, windowTouching: true },
    async ({ pid }) => {
      const start = Date.now();
      try {
        // denyClasses/windowScope apply to kill too: resolve pid → window class first.
        const s = await deps.state.snapshot();
        const client = s.clients.find((c) => c.pid === pid || (typeof pid === 'number' && c.address === `0x${pid.toString(16)}`));
        if (client) assertWindowAllowed(deps, client.class);
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

  gatedRegister(
    server,
    deps,
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
    { mutating: true, windowTouching: true },
    async ({ id, window: target }) => {
      const start = Date.now();
      try {
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'workspace');
          // One comma-joined argument: classic Hyprland parses
          // `<workspace>,<selector>`, and a space-separated pair is read as
          // a workspace name that does not exist.
          await ipc.dispatch(['movetoworkspacesilent', `${id},address:${address}`]);
          return { content: [{ type: 'text', text: JSON.stringify({ moved: address, to: id }) }], structuredContent: ok('workspace', { moved: address, to: id }, start) } as const;
        }
        await ipc.dispatch(['workspace', String(id)]);
        return { content: [{ type: 'text', text: JSON.stringify({ switched: id }) }], structuredContent: ok('workspace', { switched: id }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('workspace', e, start)) }], isError: true, structuredContent: err('workspace', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
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
    { mutating: true, windowTouching: true },
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
            // `exact <w> <h>` — Hyprland answers ok to `<w>x<h>` and resizes
            // nothing, so the wrong form here is invisible.
            await ipc.dispatch(['resizewindowpixel', `exact ${w} ${h},${sel}`]);
            break;
          }
          case 'move': {
            if (x === undefined || y === undefined) throw new HyprError('INVALID_ARGUMENTS', 'move needs x and y');
            // `exact <x> <y>` — bare numbers are a delta, and comma-separated
            // ones fail outright with "moveWindow: no window".
            await ipc.dispatch(['movewindowpixel', `exact ${Math.round(x)} ${Math.round(y)},${sel}`]);
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
}
