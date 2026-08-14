/**
 * State tools — the orient surface: desktop snapshot, window list, health.
 * All read-only; the model always starts with get_state.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import fs from 'node:fs';
import type { ServerDeps } from '../index.js';
import { err, ok, okObserved } from '../types.js';
import { configPath } from '../security.js';
import { gatedRegister, type ToolPolicy } from './guard.js';

type GatedRegister = typeof gatedRegister;

export function registerStateTools(server: McpServer, deps: ServerDeps, gatedRegister: GatedRegister): void {
  const { state, config } = deps;

  gatedRegister(
    server,
    deps,
    'get_state',
    {
      title: 'Get desktop state',
      description:
        'Snapshot of the desktop: monitors, workspaces, all windows (incl. background/special-workspace), focused window, cursor position. The orient call — always start here.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    { mutating: false, observation: true },
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
        ], structuredContent: okObserved('get_state', { windowCount: s.clients.length }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('get_state', e, start)) }], isError: true, structuredContent: err('get_state', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'list_windows',
    {
      title: 'List windows',
      description: 'All windows with class/title/pid/workspace/geometry — including background and special-workspace windows. Pass a filter substring to narrow.',
      inputSchema: z.object({ filter: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    { mutating: false, observation: true },
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
        return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }], structuredContent: okObserved('list_windows', { count: list.length, windows: list }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('list_windows', e, start)) }], isError: true, structuredContent: err('list_windows', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'health',
    {
      title: 'Server health & capabilities',
      description: 'Runtime doctor: IPC reachability, version, tool capability matrix, deny-list. Agents call this to self-diagnose.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    { mutating: false, observation: true },
    async () => {
      const start = Date.now();
      try {
        const s = await state.snapshot();
        // policyDrift: the config file changed on disk after we loaded it.
        let policyDrift = false;
        try {
          const { configLoadMtimeMs } = await import('../security.js');
          policyDrift = configLoadMtimeMs > 0 && fs.statSync(configPath()).mtimeMs > configLoadMtimeMs;
        } catch {
          policyDrift = false; // no config file → nothing drifted
        }
        const policy = {
          version: s.version,
          capabilities: config.capabilities,
          toolsAllow: config.tools.allow,
          toolsExclude: config.tools.exclude,
          dispatchAllow: config.dispatchAllow,
          denyClasses: config.denyClasses,
          windowScope: config.windowScope,
          readOnly: config.readOnly,
          strict: config.strict,
          auditPath: deps.audit.path(),
          killSwitchFile: config.session.killSwitchFile,
          policyDrift,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(policy, null, 2) }],
          structuredContent: ok('health', policy, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('health', e, start)) }], isError: true, structuredContent: err('health', e, start) } as const;
      }
    },
  );
}
