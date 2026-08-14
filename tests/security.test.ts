/**
 * P0a: Config surface — new fields load, defaults apply, catalog frozen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULT_CONFIG, SAFE_DISPATCH_CATALOG, materializeConfig, mergeConfig, classMatches } from '../src/security.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-sec-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('config surface', () => {
  it('defaults apply when no config file exists', () => {
    const cfg = loadConfig({ HYPRLAND_MCP_CONFIG: path.join(dir, 'missing.json'), ...process.env });
    expect(cfg.windowScope).toEqual([]);
    expect(cfg.tools).toEqual({ allow: [], exclude: [] });
    expect(cfg.dispatchAllow).toEqual(SAFE_DISPATCH_CATALOG);
    expect(cfg.readOnly).toBe(false);
    expect(cfg.strict).toBe(false);
    expect(cfg.session.killSwitchFile).toContain('STOP');
    expect(cfg.session.auditPath).toContain('audit.jsonl');
  });

  it('loads new fields from a config file', () => {
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({
      windowScope: ['foot', 'kitty'],
      tools: { allow: ['get_state', 'screenshot'], exclude: ['dispatch'] },
      dispatchAllow: ['focuswindow'],
      readOnly: true,
      strict: true,
      session: { killSwitchFile: '/tmp/STOP', auditPath: '/tmp/a.jsonl' },
      capabilities: { exec: false },
    }));
    const cfg = loadConfig({ HYPRLAND_MCP_CONFIG: p, ...process.env });
    expect(cfg.windowScope).toEqual(['foot', 'kitty']);
    expect(cfg.tools.allow).toEqual(['get_state', 'screenshot']);
    expect(cfg.tools.exclude).toEqual(['dispatch']);
    expect(cfg.dispatchAllow).toEqual(['focuswindow']);
    expect(cfg.readOnly).toBe(true);
    expect(cfg.strict).toBe(true);
    expect(cfg.session.killSwitchFile).toBe('/tmp/STOP');
    expect(cfg.session.auditPath).toBe('/tmp/a.jsonl');
    expect(cfg.capabilities.exec).toBe(false);
    expect(cfg.capabilities.input).toBe(true); // untouched deep-merged
  });

  it('mergeConfig deep-merges nested groups', () => {
    const cfg = mergeConfig({ capabilities: { screenshot: false } });
    expect(cfg.capabilities.exec).toBe(true);
    expect(cfg.capabilities.screenshot).toBe(false);
  });

  it('materializeConfig writes defaults only when absent', () => {
    const p = path.join(dir, 'config.json');
    const env = { HYPRLAND_MCP_CONFIG: p, ...process.env };
    materializeConfig(env);
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed.capabilities.exec).toBe(true);
    expect(Array.isArray(parsed._comment)).toBe(true);
    // idempotent — second call does not overwrite
    const before = fs.readFileSync(p, 'utf8');
    materializeConfig(env);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
    // and it round-trips through loadConfig
    expect(loadConfig(env).dispatchAllow).toEqual(SAFE_DISPATCH_CATALOG);
  });

  it('SAFE_DISPATCH_CATALOG is frozen to the exact safe set', () => {
    expect([...SAFE_DISPATCH_CATALOG].sort()).toEqual([
      'closewindow', 'focuswindow', 'fullscreen', 'movecursor', 'movetoworkspacesilent',
      'movewindowpixel', 'resizewindowpixel', 'sendshortcut', 'togglefloating',
      'togglespecialworkspace', 'workspace',
    ].sort());
    // sendclick and exec are NOT defaults (explicit opt-in / special-cased)
    expect(SAFE_DISPATCH_CATALOG).not.toContain('sendclick');
    expect(SAFE_DISPATCH_CATALOG).not.toContain('exec');
  });
});

describe('classMatches', () => {
  it('is a case-insensitive substring matcher', () => {
    expect(classMatches(['gajim'], 'org.gajim.Gajim')).toBe(true);
    expect(classMatches(['lock'], 'org.freedesktop.ScreenLock')).toBe(true); // substring is intentional
    expect(classMatches(['lock'], 'com.example.Editor')).toBe(false);
    expect(classMatches([], 'anything')).toBe(false);
  });
});
