/**
 * Security — stdio-only, observe/act separation, deny-list (adversary Part 3).
 *
 * The threat model: whoever can call this server controls the desktop. The
 * boundary is "same user, same session, stdio transport, opencode permission
 * prompts gate intent." Server-side config never enforces intent — it only
 * hard-blocks the never-touch list and gates capabilities.
 *
 * Enforcement architecture (adversarial-planning standing set):
 *   - tools.allow / tools.exclude / readOnly → registration-time hiding.
 *   - capabilities.* / denyClasses / windowScope / dispatchAllow / kill-switch
 *     → call-time guards at the gatedRegister chokepoint.
 *   - Every denial and every call lands in the append-only audit log.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HyprError } from './types.js';

/** Default dispatchers the `dispatch` tool may run. Allow-by-default, fail-closed. */
export const SAFE_DISPATCH_CATALOG: string[] = [
  'focuswindow',
  'closewindow',
  'workspace',
  'movetoworkspacesilent',
  'togglespecialworkspace',
  'movecursor',
  'resizewindowpixel',
  'movewindowpixel',
  'togglefloating',
  'fullscreen',
  'sendshortcut',
];

export interface Config {
  /** Explicit instance socket dir override. */
  socketDir?: string;
  /** Hard deny-list: windows (by class) the agent may NEVER touch. */
  denyClasses: string[];
  /** Class patterns; non-empty ⇒ only matching classes are targetable (T3). */
  windowScope: string[];
  /** Capability gates. */
  capabilities: {
    exec: boolean;
    input: boolean;
    destructive: boolean; // close/kill
    screenshot: boolean;
  };
  /** Exec allow-patterns (optional; empty = anything, or refused under strict). */
  execAllowPrefixes: string[];
  /** Unicode paste path. */
  allowClipboardPaste: boolean;
  screenshotDir: string;
  /** Tool-surface filters (Windows-MCP --tools / --exclude-tools parity). */
  tools: { allow: string[]; exclude: string[] };
  /** Dispatchers the `dispatch` tool may run. Default = SAFE_DISPATCH_CATALOG. */
  dispatchAllow: string[];
  /** true ⇒ only observation tools are registered (mutators hidden). */
  readOnly: boolean;
  /** true ⇒ exec with an empty allow-prefix list is refused, not warned. */
  strict: boolean;
  /** Session state paths. */
  session: { killSwitchFile: string; auditPath: string };
}

export const DEFAULT_CONFIG: Config = {
  denyClasses: [],
  windowScope: [],
  capabilities: { exec: true, input: true, destructive: true, screenshot: true },
  execAllowPrefixes: [],
  allowClipboardPaste: true,
  screenshotDir: path.join(os.homedir(), 'Pictures', 'hyprland-mcp'),
  tools: { allow: [], exclude: [] },
  dispatchAllow: SAFE_DISPATCH_CATALOG,
  readOnly: false,
  strict: false,
  session: {
    killSwitchFile: path.join(os.homedir(), '.config', 'hyprland-mcp', 'STOP'),
    auditPath: path.join(os.homedir(), '.config', 'hyprland-mcp', 'audit.jsonl'),
  },
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYPRLAND_MCP_CONFIG ?? path.join(os.homedir(), '.config', 'hyprland-mcp', 'config.json');
}

/** mtime of the config file at load time, for policyDrift detection. 0 = none. */
export let configLoadMtimeMs = 0;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const p = configPath(env);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    try {
      configLoadMtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      configLoadMtimeMs = 0;
    }
    return mergeConfig(parsed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      configLoadMtimeMs = 0;
      return DEFAULT_CONFIG;
    }
    throw new HyprError('INVALID_ARGUMENTS', `invalid config at ${p}: ${(e as Error).message}`, {
      hint: 'Fix or remove the config file.',
    });
  }
}

/** Deep-merge a partial config over the defaults (loadConfig + materialize). */
export function mergeConfig(parsed: Partial<Config>): Config {
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    capabilities: { ...DEFAULT_CONFIG.capabilities, ...(parsed.capabilities ?? {}) },
    tools: { ...DEFAULT_CONFIG.tools, ...(parsed.tools ?? {}) },
    session: { ...DEFAULT_CONFIG.session, ...(parsed.session ?? {}) },
    denyClasses: parsed.denyClasses ?? DEFAULT_CONFIG.denyClasses,
    windowScope: parsed.windowScope ?? DEFAULT_CONFIG.windowScope,
    execAllowPrefixes: parsed.execAllowPrefixes ?? DEFAULT_CONFIG.execAllowPrefixes,
    dispatchAllow: parsed.dispatchAllow ?? DEFAULT_CONFIG.dispatchAllow,
  };
}

/** Write a default config file if absent. main() only — tests never call this. */
export function materializeConfig(env: NodeJS.ProcessEnv = process.env): void {
  const p = configPath(env);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const doc: Config & { _comment: string[] } = {
    ...DEFAULT_CONFIG,
    _comment: [
      'hyprland-mcp config. All fields optional; defaults shown.',
      'denyClasses: window classes the agent may NEVER touch (substring match, case-insensitive).',
      'windowScope: if non-empty, only windows whose class matches a pattern may be targeted.',
      'capabilities: { exec, input, destructive, screenshot } — false hides+denies the tool group.',
      'tools: { allow, exclude } — allow = only these tools registered; exclude = never register.',
      'dispatchAllow: dispatchers the dispatch tool may run (default = safe catalog).',
      'readOnly: true registers only observation tools (get_state/list_windows/health/screenshot/OCR/wait_for/clipboard_read).',
      'strict: true makes exec with empty execAllowPrefixes refuse instead of warn.',
      'execAllowPrefixes: command prefixes launch/dispatch-exec may run; empty = anything (or refuse under strict).',
      'session.killSwitchFile: create this file to freeze all mutating tools (checked per call).',
      'session.auditPath: append-only JSONL of every call + denial.',
      'allowClipboardPaste: gate the Unicode paste path.',
      'screenshotDir: where screenshots are written.',
    ],
  };
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
}

/** Matcher: does a window class hit a pattern list (lowercased substring)? */
export function classMatches(patterns: string[], windowClass: string): boolean {
  const cls = windowClass.toLowerCase();
  return patterns.some((d) => cls.includes(d.toLowerCase()));
}

/** Guard: is this window class on the never-touch list? */
export function assertNotDenied(config: Config, windowClass: string): void {
  if (classMatches(config.denyClasses, windowClass)) {
    throw new HyprError('PERMISSION_DENIED', `window class "${windowClass}" is on the deny-list`, {
      hint: 'The user has configured this class as never-touch.',
    });
  }
}

/** Guard: may we exec this command prefix? Empty allowlist = anything (strict: refuse). */
export function assertExecAllowed(config: Config, cmd: string): void {
  if (!config.capabilities.exec) {
    throw new HyprError('PERMISSION_DENIED', 'exec capability is disabled in config');
  }
  if (config.execAllowPrefixes.length === 0) {
    if (config.strict) {
      throw new HyprError('PERMISSION_DENIED', 'exec is enabled but execAllowPrefixes is empty under strict mode', {
        hint: 'Set execAllowPrefixes, or disable exec, or turn off strict.',
      });
    }
    return;
  }
  const ok = config.execAllowPrefixes.some((p) => cmd.startsWith(p));
  if (!ok) {
    throw new HyprError('PERMISSION_DENIED', `command "${cmd}" is not in the exec allowlist`);
  }
}
