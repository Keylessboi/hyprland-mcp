/**
 * Discovery — find the running Hyprland instance.
 *
 * Never require env vars (adversary R1): scan the runtime dir, validate with
 * a sanity call, allow explicit config override. Runs at startup AND on every
 * reconnect (instance signature changes per compositor restart).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HyprError } from './types.js';
import type { HyprlandConfig } from './ipc.js';

export interface DiscoveryOptions {
  /** Explicit socketDir override (config file). */
  overrideDir?: string;
  /** Injectable env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Injectable home/runtime resolution for tests. */
  runtimeDir?: string;
}

export interface DiscoveredInstance {
  socketDir: string;
  signature: string;
}

/** Candidate instance dirs, most-recent-first. */
export function candidateDirs(opts: DiscoveryOptions): string[] {
  const env = opts.env ?? process.env;
  const candidates: string[] = [];

  // 1. explicit config override wins
  if (opts.overrideDir) candidates.push(opts.overrideDir);

  // 2. HYPRLAND_INSTANCE_SIGNATURE env
  const sig = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (sig) {
    const runtime = opts.runtimeDir ?? env.XDG_RUNTIME_DIR ?? `/run/user/${os.userInfo().uid}`;
    candidates.push(path.join(runtime, 'hypr', sig));
  }

  // 3. scan the runtime dir
  const runtime = opts.runtimeDir ?? env.XDG_RUNTIME_DIR ?? `/run/user/${os.userInfo().uid}`;
  const hyprDir = path.join(runtime, 'hypr');
  try {
    const entries = fs.readdirSync(hyprDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(hyprDir, e.name))
      .sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
    candidates.push(...dirs);
  } catch {
    // runtime dir missing — will fail validation with a clear error
  }

  // dedupe preserving order
  return [...new Set(candidates)];
}

function isAlive(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.socket.sock'));
}

/**
 * Resolve a live instance, validating the socket exists. Full validation
 * (a `monitors` round trip) is the caller's job via HyprIpc.
 */
export function discoverInstance(opts: DiscoveryOptions = {}): DiscoveredInstance {
  for (const dir of candidateDirs(opts)) {
    if (isAlive(dir)) {
      return { socketDir: dir, signature: path.basename(dir) };
    }
  }
  throw new HyprError('MISSING_SESSION', 'no live Hyprland instance found', {
    hint: 'Run inside the Hyprland session (or set HYPRLAND_INSTANCE_SIGNATURE / config socketDir).',
  });
}

export function toConfig(instance: DiscoveredInstance, timeoutMs?: number): HyprlandConfig {
  return { socketDir: instance.socketDir, timeoutMs };
}
