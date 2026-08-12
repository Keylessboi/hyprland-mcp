/**
 * Security — stdio-only, observe/act separation, deny-list (adversary Part 3).
 *
 * The threat model: whoever can call this server controls the desktop. The
 * boundary is "same user, same session, stdio transport, opencode permission
 * prompts gate intent." Server-side config never enforces intent — it only
 * hard-blocks the never-touch list and gates capabilities.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HyprError } from './types.js';

export interface Config {
  /** Explicit instance socket dir override. */
  socketDir?: string;
  /** Hard deny-list: windows (by class) the agent may NEVER touch. */
  denyClasses: string[];
  /** Capability gates. */
  capabilities: {
    exec: boolean;
    input: boolean;
    destructive: boolean; // close/kill
    screenshot: boolean;
  };
  /** Exec allow-patterns (optional; empty = any). */
  execAllowPrefixes: string[];
  /** Unicode paste path. */
  allowClipboardPaste: boolean;
  screenshotDir: string;
}

export const DEFAULT_CONFIG: Config = {
  denyClasses: [],
  capabilities: { exec: true, input: true, destructive: true, screenshot: true },
  execAllowPrefixes: [],
  allowClipboardPaste: true,
  screenshotDir: path.join(os.homedir(), 'Pictures', 'hyprland-mcp'),
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYPRLAND_MCP_CONFIG ?? path.join(os.homedir(), '.config', 'hyprland-mcp', 'config.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = configPath(env);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      capabilities: { ...DEFAULT_CONFIG.capabilities, ...(parsed.capabilities ?? {}) },
      denyClasses: parsed.denyClasses ?? DEFAULT_CONFIG.denyClasses,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    throw new HyprError('INVALID_ARGUMENTS', `invalid config at ${p}: ${(e as Error).message}`, {
      hint: 'Fix or remove the config file.',
    });
  }
}

/** Guard: is this window class on the never-touch list? */
export function assertNotDenied(config: Config, windowClass: string): void {
  const cls = windowClass.toLowerCase();
  if (config.denyClasses.some((d) => cls.includes(d.toLowerCase()))) {
    throw new HyprError('PERMISSION_DENIED', `window class "${windowClass}" is on the deny-list`, {
      hint: 'The user has configured this class as never-touch.',
    });
  }
}

/** Guard: may we exec this command prefix? Empty allowlist = anything. */
export function assertExecAllowed(config: Config, cmd: string): void {
  if (!config.capabilities.exec) {
    throw new HyprError('PERMISSION_DENIED', 'exec capability is disabled in config');
  }
  if (config.execAllowPrefixes.length === 0) return;
  const ok = config.execAllowPrefixes.some((p) => cmd.startsWith(p));
  if (!ok) {
    throw new HyprError('PERMISSION_DENIED', `command "${cmd}" is not in the exec allowlist`);
  }
}
