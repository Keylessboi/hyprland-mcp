/**
 * Live check: does `launch` keep an app off the user's screen?
 *
 *   node scripts/live-workspace-check.mjs ./dist/hyprland-mcp [name:agent]
 *
 * This runs against the real compositor someone is sitting at, so it is
 * written to be provably safe for them: every window present beforehand is
 * recorded, the only window it ever acts on is the address its own launch
 * returns, and it fails loudly if the user's active workspace or any of their
 * windows moved. Speaks MCP over stdio directly — no client dependency, so it
 * can be run against a built binary on any machine.
 */
import { spawn } from 'node:child_process';

const BIN = process.argv[2];
const WS = process.argv[3] ?? 'name:agent';
if (!BIN) {
  console.error('usage: live-workspace-check.mjs <path-to-hyprland-mcp> [workspace]');
  process.exit(2);
}

const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
const pending = new Map();
let id = 0;
let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (let nl; (nl = buf.indexOf('\n')) !== -1; ) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  }
});

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    setTimeout(() => pending.has(n) && (pending.delete(n), reject(new Error(`${method} timed out`))), 30000);
  });

const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.content?.find((p) => p.type === 'text')?.text ?? '';
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

/** The two things that must not change: what the user is looking at, and their windows. */
const shape = (s) => ({
  active: s.monitors.map((m) => `${m.name}:${m.activeWorkspace?.name ?? m.activeWorkspace?.id}`).sort().join(','),
  windows: Object.fromEntries(s.windows.map((c) => [c.address, `${c.class}@${c.workspaceName}`])),
});

const fail = async (why) => { console.log('RESULT: FAIL —', why); proc.kill(); process.exit(1); };

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-workspace-check', version: '0' } });
notify('notifications/initialized', {});

const before = shape(await call('get_state'));
console.log('BEFORE active:', before.active, '| user windows:', Object.keys(before.windows).length);

const res = await call('launch', {
  command: 'foot',
  args: ['-T', 'hyprland-mcp-live-check', '-e', 'sleep', '120'],
  workspace: WS,
  wait_for_window: true,
  timeout_ms: 15000,
});
console.log('LAUNCH:', JSON.stringify(res));

const mine = res.window?.address ?? res.window;
if (typeof mine !== 'string' || !mine.startsWith('0x')) await fail('launch returned no window address');
if (before.windows[mine]) await fail('launch returned a pre-existing window; refusing to touch it');

const during = shape(await call('get_state'));
console.log('DURING active:', during.active, '| launched window:', during.windows[mine]);
const placed = (during.windows[mine] ?? '').endsWith('@' + WS.replace(/^name:/, ''));
const heldDuring = during.active === before.active && Object.entries(before.windows).every(([a, v]) => during.windows[a] === v);

// Clean up only our own window, by the address launch reported.
await call('close', { target: mine });
await new Promise((r) => setTimeout(r, 1000));
const after = shape(await call('get_state'));
const heldAfter = after.active === before.active && Object.entries(before.windows).every(([a, v]) => after.windows[a] === v);
console.log('AFTER active:', after.active, '| launched window gone:', !after.windows[mine]);

const checks = {
  [`placed on ${WS}`]: placed,
  'user active workspace unchanged': heldDuring && heldAfter,
  'user windows untouched': heldDuring && heldAfter,
  'own window cleaned up': !after.windows[mine],
};
for (const [k, v] of Object.entries(checks)) console.log(`CHECK ${k}: ${v ? 'pass' : 'FAIL'}`);
console.log('RESULT:', Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL');
proc.kill();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
