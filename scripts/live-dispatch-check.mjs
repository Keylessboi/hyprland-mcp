/**
 * Live check: does every translated dispatcher actually DO something?
 *
 *   node scripts/live-dispatch-check.mjs ./dist/hyprland-mcp
 *
 * Hyprland 0.56's `hl.dsp.global` answers "ok" for any classic verb and
 * performs nothing, so "the compositor said ok" proves nothing. Each verb here
 * is checked by its observable effect instead — the window really moved
 * workspace, really changed size, really changed position.
 *
 * Safe by construction: everything happens to one window this script launched,
 * on its own named workspace, and the user's active workspace and windows are
 * compared before and after.
 */
import { spawn } from 'node:child_process';

const BIN = process.argv[2];
if (!BIN) { console.error('usage: live-dispatch-check.mjs <path-to-hyprland-mcp>'); process.exit(2); }
const WS = 'name:mcp-dispatch-check';
const WS2 = 'name:mcp-dispatch-check-2';

const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const pending = new Map();
let id = 0, buf = '';
proc.stdout.on('data', (c) => {
  buf += c.toString('utf8');
  for (let nl; (nl = buf.indexOf('\n')) !== -1; ) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, { resolve, reject });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  setTimeout(() => pending.has(n) && (pending.delete(n), reject(new Error(`${method} timed out`))), 30000);
});
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.content?.find((p) => p.type === 'text')?.text ?? '';
  let v; try { v = JSON.parse(text); } catch { v = { raw: text }; }
  if (r.isError) throw new Error(`${name}: ${text}`);
  return v;
};
/** Refusals we want to report, not crash on — the lock guard is one. */
const tryCall = async (name, args = {}) => {
  try { return { ok: true, value: await call(name, args) }; }
  catch (e) { return { ok: false, error: String(e.message ?? e) }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const win = async (addr) => (await call('get_state')).windows.find((w) => w.address === addr);
const userShape = (s) => ({
  active: s.monitors.map((m) => `${m.name}:${m.activeWorkspace?.name ?? m.activeWorkspace?.id}`).sort().join(','),
  windows: Object.fromEntries(s.windows.map((c) => [c.address, `${c.class}@${c.workspaceName}`])),
});

const results = [];
const check = (name, pass, detail) => { results.push([name, pass, detail]); console.log(`CHECK ${name}: ${pass ? 'pass' : 'FAIL'}${detail ? ` (${detail})` : ''}`); };

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-dispatch-check', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');

const before = userShape(await call('get_state'));
console.log('BEFORE active:', before.active, '| user windows:', Object.keys(before.windows).length);

const res = await call('launch', { command: 'foot', args: ['-T', 'mcp-dispatch-check', '-e', 'sleep', '180'], workspace: WS, wait_for_window: true, timeout_ms: 15000 });
const addr = res.window?.address ?? res.window;
if (typeof addr !== 'string' || !addr.startsWith('0x') || before.windows[addr]) {
  console.log('RESULT: FAIL — no safe window of our own to test with'); proc.kill(); process.exit(1);
}
try {
  console.log('launched', addr, 'on', (await win(addr))?.workspaceName);
  check(`exec rule places on ${WS}`, (await win(addr))?.workspaceName === WS.slice(5));

  // movetoworkspacesilent — the verb that silently did nothing under hl.dsp.global
  await call('workspace', { id: WS2, window: addr });
  await sleep(400);
  check('movetoworkspacesilent moves the window', (await win(addr))?.workspaceName === WS2.slice(5), (await win(addr))?.workspaceName);
  await call('workspace', { id: WS, window: addr });
  await sleep(400);
  check('movetoworkspacesilent moves it back', (await win(addr))?.workspaceName === WS.slice(5));

  // float, then geometry: a tiled window ignores an explicit size. These go
  // through the lock guard, so on a locked screen they are skipped, not failed.
  const floated = await tryCall('window', { target: addr, action: 'float' });
  if (!floated.ok && /SESSION_LOCKED/.test(floated.error)) {
    console.log('SKIP geometry checks: the desktop is locked and the lock guard refuses window actions');
  } else {
    await sleep(400);
    await call('window', { target: addr, action: 'resize', w: 640, h: 480 });
    await sleep(400);
    const sized = await win(addr);
    check('resizewindowpixel applies an exact size', sized?.size?.[0] === 640 && sized?.size?.[1] === 480, `size=${JSON.stringify(sized?.size)}`);

    await call('window', { target: addr, action: 'move', x: 120, y: 140 });
    await sleep(400);
    const moved = await win(addr);
    check('movewindowpixel applies an absolute position', moved?.at?.[0] === 120 && moved?.at?.[1] === 140, `at=${JSON.stringify(moved?.at)}`);

    // Classic Hyprland's fullscreen dispatcher only reaches a window the
    // compositor can make active, so on the string dialect a window parked on
    // a hidden workspace is legitimately out of reach. The Lua dispatcher
    // takes a window selector and has no such limit.
    const fs = await tryCall('window', { target: addr, action: 'fullscreen' });
    if (!fs.ok && /Window not found/.test(fs.error)) {
      console.log('SKIP fullscreen: the classic dialect cannot target a window on a hidden workspace');
    } else if (!fs.ok) {
      check('fullscreen dispatch accepted', false, fs.error);
    } else {
      await sleep(500);
      const full = await win(addr);
      check('fullscreen changes the window geometry', full?.size?.[0] !== 640 || full?.size?.[1] !== 480, `size=${JSON.stringify(full?.size)}`);
      await call('window', { target: addr, action: 'fullscreen' });
      await sleep(400);
    }
  }
} finally {
  // Always hand the window back, however a check ended.
  await call('close', { target: addr });
}

await sleep(1000);
const after = userShape(await call('get_state'));
check('own window cleaned up', !after.windows[addr]);
check('user active workspace unchanged', after.active === before.active, `${before.active} → ${after.active}`);
check('user windows untouched', Object.entries(before.windows).every(([a, v]) => after.windows[a] === v));

const pass = results.every(([, p]) => p);
console.log('RESULT:', pass ? 'PASS' : 'FAIL');
proc.kill();
process.exit(pass ? 0 : 1);
