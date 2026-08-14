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

type GatedRegister = typeof gatedRegister;

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
        if (workspace !== undefined) {
          // Atomic placement: Hyprland opens the window on the target
          // workspace directly via the exec rule. No server-side pid is
          // available (the compositor forks), so wait_for_window matches by
          // class, and cleanup goes through close/kill on the window.
          const wsSpec = String(workspace);
          // silent: open on the target workspace WITHOUT stealing focus or
          // switching the user's active workspace (verified: active ws stays
          // put; the app lands on the named workspace unfocused)
          await ipc.dispatch(['exec', `[workspace ${wsSpec} silent] ${quoteJoin([command, ...args])}`]);
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
}
