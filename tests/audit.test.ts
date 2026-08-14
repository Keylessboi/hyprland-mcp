/**
 * P0a: AuditLog — append-only JSONL of every call + denial.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, type AuditEntry } from '../src/audit.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-audit-test-'));
  file = path.join(dir, 'audit.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AuditLog', () => {
  it('appends a valid JSONL line per entry', () => {
    const log = new AuditLog(file);
    log.append({ ts: 't1', tool: 'input_click', args: { x: 1 }, windowClass: null, denied: false, rule: null, ok: true });
    log.append({ ts: 't2', tool: 'close', args: { target: 'gajim' }, windowClass: 'Gajim', denied: true, rule: 'denyClasses', ok: false });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as AuditEntry;
    expect(first.tool).toBe('input_click');
    expect(first.denied).toBe(false);
    const second = JSON.parse(lines[1]!) as AuditEntry;
    expect(second.rule).toBe('denyClasses');
    expect(second.windowClass).toBe('Gajim');
  });

  it('creates missing directories', () => {
    const nested = path.join(dir, 'deep', 'nested', 'audit.jsonl');
    const log = new AuditLog(nested);
    log.append({ ts: 't', tool: 'health', args: {}, windowClass: null, denied: false, rule: null, ok: true });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('fails open when the file cannot be written (no throw)', () => {
    const ro = path.join(dir, 'ro', 'audit.jsonl');
    fs.mkdirSync(path.dirname(ro));
    fs.chmodSync(path.dirname(ro), 0o500);
    const log = new AuditLog(ro);
    expect(() => log.append({ ts: 't', tool: 'x', args: {}, windowClass: null, denied: false, rule: null, ok: true })).not.toThrow();
  });

  it('path() returns the configured path', () => {
    expect(new AuditLog(file).path()).toBe(file);
  });
});
