/**
 * Launch records — what happened to an app after `launch`.
 *
 * Testing software means reading its output and noticing when it dies, not
 * just seeing a window appear. Every launch runs under a tiny /bin/sh
 * wrapper that records, in a private per-launch directory:
 *
 *   pid    the app's pid (the wrapper's direct child)
 *   out    the app's merged stdout + stderr
 *   exit   the app's exit status, written when it ends (128+N = signal N)
 *
 * The wrapper works for both launch paths: a direct spawn, and Hyprland's
 * `dispatch exec [workspace …]`, whose window rule still applies because
 * Hyprland matches exec rules against the window's whole parent-pid chain.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** $1 = record dir, rest = argv. Written to be readable, not clever. */
export const WRAPPER_SCRIPT =
  'd=$1; shift; "$@" >"$d/out" 2>&1 </dev/null & c=$!; echo $c >"$d/pid"; wait $c; echo $? >"$d/exit"';

export interface LaunchRecord {
  id: string;
  dir: string;
  command: string;
  args: string[];
  workspace?: string;
  startedAt: number;
}

export interface LaunchStatus {
  launch_id: string;
  command: string;
  args: string[];
  workspace?: string;
  pid: number | null;
  running: boolean;
  exit_code: number | null;
  /** Set when the app was killed by a signal (exit status 128+N). */
  signal: number | null;
  runtime_ms: number;
  output: string;
  output_bytes: number;
  output_truncated: boolean;
}

export function launchRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HYPRLAND_MCP_LAUNCH_DIR) return env.HYPRLAND_MCP_LAUNCH_DIR;
  const base = env.XDG_RUNTIME_DIR || tmpdir();
  return join(base, 'hyprland-mcp', 'launches');
}

function readIntFile(path: string): number | null {
  try {
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function tailFile(path: string, maxBytes: number): { text: string; size: number; truncated: boolean } {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { text: '', size: 0, truncated: false };
  }
  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return { text: buf.toString('utf8'), size, truncated: size > len };
}

/** Is `pid` alive (and not a zombie)? */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/\) Z /.test(stat);
  } catch {
    return false;
  }
}

/** Parent pid from /proc, or null. */
export function ppidOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(after[1]);
  } catch {
    return null;
  }
}

/** True when `pid` is `ancestor` or one of its descendants. */
export function inProcessTree(pid: number, ancestor: number, ppid: (p: number) => number | null = ppidOf): boolean {
  let cur: number | null = pid;
  for (let i = 0; i < 64 && cur && cur > 1; i++) {
    if (cur === ancestor) return true;
    cur = ppid(cur);
  }
  return false;
}

export class LaunchRegistry {
  private records = new Map<string, LaunchRecord>();

  constructor(private readonly root: string = launchRoot()) {}

  /** Create a record dir and return the wrapper argv (starting with /bin/sh). */
  prepare(command: string, args: string[], workspace?: string): { record: LaunchRecord; argv: string[] } {
    const id = `l-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: LaunchRecord = { id, dir, command, args, workspace, startedAt: Date.now() };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(record), { mode: 0o600 });
    this.records.set(id, record);
    return { record, argv: ['/bin/sh', '-c', WRAPPER_SCRIPT, 'hyprland-mcp-launch', dir, command, ...args] };
  }

  /** Wait briefly for the wrapper to report the app pid. */
  async waitForPid(record: LaunchRecord, timeoutMs = 3000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pid = readIntFile(join(record.dir, 'pid'));
      if (pid) return pid;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  get(id: string): LaunchRecord | undefined {
    const known = this.records.get(id);
    if (known) return known;
    // Survive a server restart: the record dir is the source of truth.
    const meta = join(this.root, id, 'meta.json');
    if (/^l-[a-z0-9]+-[0-9a-f]{6}$/.test(id) && existsSync(meta)) {
      const rec = JSON.parse(readFileSync(meta, 'utf8')) as LaunchRecord;
      this.records.set(id, rec);
      return rec;
    }
    return undefined;
  }

  list(): LaunchRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  status(record: LaunchRecord, tailBytes = 16_000): LaunchStatus {
    const pid = readIntFile(join(record.dir, 'pid'));
    const exit = readIntFile(join(record.dir, 'exit'));
    const out = tailFile(join(record.dir, 'out'), tailBytes);
    const running = exit === null && pid !== null && alive(pid);
    return {
      launch_id: record.id,
      command: record.command,
      args: record.args,
      ...(record.workspace ? { workspace: record.workspace } : {}),
      pid,
      running,
      exit_code: exit,
      signal: exit !== null && exit > 128 ? exit - 128 : null,
      runtime_ms: Date.now() - record.startedAt,
      output: out.text,
      output_bytes: out.size,
      output_truncated: out.truncated,
    };
  }
}
