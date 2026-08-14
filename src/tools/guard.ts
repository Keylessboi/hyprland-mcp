/**
 * gatedRegister — the single security chokepoint for the tool surface.
 *
 * Every tool registers through this wrapper. It applies, in order:
 *   1. registration-time policy (tools.allow / tools.exclude / readOnly)
 *   2. call-time capability gates + kill-switch
 *   3. audit logging of every call (allowed or denied)
 *
 * Design choice: ALL tools stay registered (visible in tools/list); hidden or
 * denied tools return a structured PERMISSION_DENIED envelope from the guard
 * rather than vanishing or throwing an SDK ProtocolError. "Denied calls return
 * structured PERMISSION_DENIED, never silent tool-not-found" is the load-bearing
 * contract — this implementation guarantees it without reaching into SDK
 * internals (no _getRequestHandler / setRequestHandler override).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../index.js';
import type { Config } from '../security.js';
import fs from 'node:fs';
import { err, ok } from '../types.js';
import type { AuditEntry } from '../audit.js';

export type CapabilityName = 'exec' | 'input' | 'destructive' | 'screenshot';

export interface ToolPolicy {
  /** Capability flags that must be true for this tool to run. */
  caps?: CapabilityName[];
  /** Does this tool mutate the desktop? (kill-switch applies) */
  mutating: boolean;
  /** Does this tool resolve a window target? (denyClasses applies in resolveUnique) */
  windowTouching?: boolean;
  /** Observation tool (readOnly keeps these). */
  observation?: boolean;
}

export interface PolicyEntry {
  name: string;
  policy: ToolPolicy;
  hidden: boolean;
  hideRule: string | null;
}

export const POLICY_REGISTRY = new Map<string, PolicyEntry>();

function deniedEnvelope(rule: string, msg: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: { code: 'PERMISSION_DENIED', message: msg, recoverable: true }, rule }) }],
    structuredContent: { ok: false, action: '', error: { code: 'PERMISSION_DENIED' as const, message: msg, recoverable: true }, ms: 0, rule },
    isError: true,
  };
}

/** Resolve registration-time hiding for a tool name. */
export function resolveHidden(config: Config, name: string, policy: ToolPolicy): { hidden: boolean; rule: string | null } {
  if (config.tools.allow.length > 0 && !config.tools.allow.includes(name)) {
    return { hidden: true, rule: 'tools.allow' };
  }
  if (config.tools.exclude.includes(name)) {
    return { hidden: true, rule: 'tools.exclude' };
  }
  if (config.readOnly && !policy.observation) {
    return { hidden: true, rule: 'readOnly' };
  }
  return { hidden: false, rule: null };
}

/** Does a mutation-denying condition apply at call time? */
export function callTimeDenial(config: Config, entry: PolicyEntry): { denied: boolean; rule: string | null; msg: string } {
  if (entry.hidden) {
    return { denied: true, rule: entry.hideRule ?? 'excluded', msg: `tool "${entry.name}" is not enabled by policy` };
  }
  if (entry.policy.mutating && fs.existsSync(config.session.killSwitchFile)) {
    return { denied: true, rule: 'killSwitch', msg: 'kill-switch is engaged: mutating tools are frozen' };
  }
  for (const cap of entry.policy.caps ?? []) {
    if (!config.capabilities[cap]) {
      return { denied: true, rule: `capabilities.${cap}`, msg: `capability "${cap}" is disabled in config` };
    }
  }
  return { denied: false, rule: null, msg: '' };
}

/**
 * Register a tool through the security chokepoint.
 * Replaces `server.registerTool` everywhere.
 */
export function gatedRegister(
  server: McpServer,
  deps: ServerDeps,
  name: string,
  cfg: { title: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> },
  policy: ToolPolicy,
  handler: (args: any) => Promise<any>,
): void {
  const { hidden, rule } = resolveHidden(deps.config, name, policy);
  POLICY_REGISTRY.set(name, { name, policy, hidden, hideRule: rule });

  const guarded: typeof handler = async (args) => {
    const start = Date.now();
    const entry = POLICY_REGISTRY.get(name)!;
    const denial = callTimeDenial(deps.config, entry);
    const auditBase = { ts: new Date().toISOString(), tool: name, args, windowClass: null, denied: false, rule: null, ok: true };

    if (denial.denied) {
      const event: AuditEntry = { ...auditBase, denied: true, rule: denial.rule, ok: false };
      deps.audit.append(event);
      return deniedEnvelope(denial.rule ?? 'excluded', denial.msg);
    }

    try {
      const result = await handler(args);
      // capture handler-level PERMISSION_DENIED (from resolveUnique/assertExecAllowed)
      const sc = result?.structuredContent as { ok?: boolean; error?: { code?: string }; rule?: string; windowClass?: string } | undefined;
      const denied = sc?.ok === false && sc.error?.code === 'PERMISSION_DENIED';
      const event: AuditEntry = {
        ...auditBase,
        denied: denied ?? false,
        rule: denied ? (sc?.rule ?? null) : null,
        windowClass: denied ? (sc?.windowClass ?? null) : null,
        ok: sc?.ok ?? false,
      };
      deps.audit.append(event);
      return result;
    } catch (e) {
      // Handler threw unexpectedly (it should self-catch; do not swallow).
      const msg = e instanceof Error ? e.message : String(e);
      deps.audit.append({ ...auditBase, denied: false, ok: false });
      return { content: [{ type: 'text', text: JSON.stringify(err(name, e, start)) }], isError: true, structuredContent: err(name, e, start) } as const;
    }
  };

  server.registerTool(name, cfg as any, guarded);
}

/** Diagnostic: effective policy summary (used by health / tests). */
export function effectivePolicySummary(config: Config): { visible: string[]; hidden: { name: string; rule: string }[] } {
  const visible: string[] = [];
  const hidden: { name: string; rule: string }[] = [];
  for (const [name, entry] of POLICY_REGISTRY) {
    if (entry.hidden) hidden.push({ name, rule: entry.hideRule ?? 'excluded' });
    else visible.push(name);
  }
  return { visible: visible.sort(), hidden };
}
