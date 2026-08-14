/**
 * Window addressing — resolve a user-supplied target (address, class, title,
 * or pid) to a unique window, or throw the actionable error.
 */
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { HyprError } from '../types.js';
import { classMatches } from '../security.js';

export const targetSchema = z.union([z.string(), z.number()]).describe('Window: address (0x…), class, title, or pid');

export const wsIdSchema = z.number().int().describe('Workspace id (negative = special workspace)');

/** denyClasses + windowScope check. Runs after a unique resolve — never shadows
 *  WINDOW_AMBIGUOUS / WINDOW_NOT_FOUND. */
export function assertWindowAllowed(
  deps: ServerDeps,
  windowClass: string,
): void {
  const cfg = deps.config;
  if (classMatches(cfg.denyClasses, windowClass)) {
    throw new HyprError('PERMISSION_DENIED', `window class "${windowClass}" is on the deny-list`, {
      hint: 'The user has configured this class as never-touch.',
      rule: 'denyClasses',
      windowClass,
    });
  }
  if (cfg.windowScope.length > 0 && !classMatches(cfg.windowScope, windowClass)) {
    throw new HyprError('PERMISSION_DENIED', `window class "${windowClass}" is outside windowScope`, {
      hint: `windowScope limits targeting to classes matching: ${cfg.windowScope.join(', ')}`,
      rule: 'windowScope',
      windowClass,
    });
  }
}

export async function resolveUnique(
  deps: ServerDeps,
  target: string | number,
  action: string,
): Promise<{ address: string; window: import('../types.js').HyprWindow }> {
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
  assertWindowAllowed(deps, w.class);
  return { address: w.address, window: w };
}
