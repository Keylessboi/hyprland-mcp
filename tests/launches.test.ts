/**
 * Launch records — the wrapper runs for real under /bin/sh; no compositor.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LaunchRegistry, inProcessTree } from '../src/launches.js';

async function run(reg: LaunchRegistry, cmd: string, args: string[]) {
  const { record, argv } = reg.prepare(cmd, args);
  const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore' });
  await new Promise((r) => child.on('close', r));
  return record;
}

describe('LaunchRegistry', () => {
  const reg = new LaunchRegistry(fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-launch-test-')));

  it('records pid, merged output and exit status', async () => {
    const rec = await run(reg, '/bin/sh', ['-c', 'echo out; echo err >&2; exit 5']);
    const st = reg.status(rec);
    expect(st.pid).toBeGreaterThan(1);
    expect(st).toMatchObject({ running: false, exit_code: 5, signal: null, output: 'out\nerr\n', output_truncated: false });
  });

  it('reports the signal when the app is killed', async () => {
    const rec = await run(reg, '/bin/sh', ['-c', 'kill -9 $$']);
    expect(reg.status(rec)).toMatchObject({ exit_code: 137, signal: 9 });
  });

  it('keeps argv intact (no shell re-splitting)', async () => {
    const rec = await run(reg, '/bin/echo', ['a b', "it's", '$(id)']);
    expect(reg.status(rec).output).toBe("a b it's $(id)\n");
  });

  it('tails long output', async () => {
    const rec = await run(reg, '/bin/sh', ['-c', 'seq 1 5000']);
    const st = reg.status(rec, 10);
    expect(st.output_truncated).toBe(true);
    expect(st.output.trimEnd().endsWith('5000')).toBe(true);
  });

  it('shows a running app as running, and finds records by id after a restart', async () => {
    const { record, argv } = reg.prepare('/bin/sleep', ['5']);
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'ignore' });
    const pid = await reg.waitForPid(record);
    expect(reg.status(record)).toMatchObject({ running: true, exit_code: null, pid });
    const fresh = new LaunchRegistry(path.dirname(record.dir));
    expect(fresh.get(record.id)?.command).toBe('/bin/sleep');
    expect(fresh.get('../../etc')).toBeUndefined();
    process.kill(pid!, 'SIGTERM');
    await new Promise((r) => child.on('close', r));
    expect(reg.status(record)).toMatchObject({ running: false, signal: 15 });
  });
});

describe('inProcessTree', () => {
  const parents: Record<number, number> = { 400: 300, 300: 200, 200: 1 };
  const ppid = (p: number) => parents[p] ?? null;
  it('walks the parent chain', () => {
    expect(inProcessTree(400, 200, ppid)).toBe(true);
    expect(inProcessTree(400, 400, ppid)).toBe(true);
    expect(inProcessTree(400, 999, ppid)).toBe(false);
  });
});
