/**
 * System tools — the raw dispatch escape hatch. Allow-by-default catalog:
 * only dispatchers listed in config.dispatchAllow may run. Arguments are
 * validated argv, never shell strings.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { err, ok } from '../types.js';
import { assertExecAllowed } from '../security.js';
import { gatedRegister, type ToolPolicy } from './guard.js';

type GatedRegister = typeof gatedRegister;

export function registerSystemTools(server: McpServer, deps: ServerDeps, gatedRegister: GatedRegister): void {
  const { ipc, config } = deps;

  gatedRegister(
    server,
    deps,
    'dispatch',
    {
      title: 'Hyprland dispatch (advanced)',
      description: 'Raw hyprctl dispatch passthrough, allow-by-default: only dispatchers in config.dispatchAllow may run (default = the safe catalog the server\'s own tools use). exec is additionally gated by capabilities.exec + execAllowPrefixes. Arguments are validated argv, never shell strings. ADVANCED.',
      inputSchema: z.object({ args: z.array(z.string()).min(1) }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    { mutating: true },
    async ({ args }) => {
      const start = Date.now();
      try {
        const dispatcher = args[0]!;
        // exec is a conditional dispatcher: allowed when caps.exec permits and
        // the command passes execAllowPrefixes (default catalog excludes it).
        const isExec = dispatcher === 'exec';
        const allowed = isExec ? config.capabilities.exec : config.dispatchAllow.includes(dispatcher);
        if (!allowed) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: `dispatcher "${dispatcher}" is not in dispatchAllow`, recoverable: true }, rule: 'dispatchAllow' }) }],
            structuredContent: { ok: false, action: 'dispatch', error: { code: 'PERMISSION_DENIED', message: `dispatcher "${dispatcher}" is not in dispatchAllow`, recoverable: true }, ms: Date.now() - start, rule: 'dispatchAllow' },
            isError: true,
          } as const;
        }
        if (isExec) {
          assertExecAllowed(config, args.slice(1).join(' '));
        }
        await ipc.dispatch(args);
        return { content: [{ type: 'text', text: JSON.stringify({ dispatched: args.join(' ') }) }], structuredContent: ok('dispatch', { args }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('dispatch', e, start)) }], isError: true, structuredContent: err('dispatch', e, start) } as const;
      }
    },
  );
}
