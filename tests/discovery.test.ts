/**
 * Discovery — instance resolution (adversary R1 mitigation).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { discoverInstance, candidateDirs } from '../src/discovery.js';
import { startFakeHyprland, type FakeHyprland } from './harness.js';
import fs from 'node:fs';
import path from 'node:path';

let fakes: FakeHyprland[] = [];
afterEach(() => {
  for (const f of fakes) f.close();
  fakes = [];
});

describe('discovery', () => {
  it('finds a live instance via env HYPRLAND_INSTANCE_SIGNATURE', async () => {
    const runtime = fs.mkdtempSync(path.join('/tmp', 'hypr-runtime-'));
    const sig = 'test-sig-123';
    const sigDir = path.join(runtime, 'hypr', sig);
    fs.mkdirSync(sigDir, { recursive: true });
    const fake = await startFakeHyprland({ respond: { 'j/monitors': '[]' }, socketDir: sigDir });
    fakes.push(fake);

    const inst = discoverInstance({
      env: { XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: sig },
      runtimeDir: runtime,
    });
    expect(inst.signature).toBe(sig);
    expect(inst.socketDir).toBe(sigDir);
  });

  it('falls back to scanning the runtime dir when env is absent', async () => {
    const runtime = fs.mkdtempSync(path.join('/tmp', 'hypr-scan-'));
    const sigDir = path.join(runtime, 'hypr', 'sig-abc');
    fs.mkdirSync(sigDir, { recursive: true });
    const fake = await startFakeHyprland({ respond: {}, socketDir: sigDir });
    fakes.push(fake);

    const inst = discoverInstance({ env: {}, runtimeDir: runtime });
    expect(inst.signature).toBe('sig-abc');
  });

  it('honors explicit override first', async () => {
    const fake = await startFakeHyprland({ respond: {} });
    fakes.push(fake);
    const inst = discoverInstance({ overrideDir: fake.dir });
    expect(inst.socketDir).toBe(fake.dir);
  });

  it('throws MISSING_SESSION when nothing is live', () => {
    expect(() => discoverInstance({ env: {}, runtimeDir: '/nonexistent-runtime' })).toThrowError(
      expect.objectContaining({ code: 'MISSING_SESSION' }),
    );
  });

  it('candidateDirs does not throw when runtime dir is missing', () => {
    expect(() => candidateDirs({ env: {}, runtimeDir: '/nonexistent' })).not.toThrow();
  });
});
