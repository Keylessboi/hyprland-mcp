/**
 * Audit — append-only JSONL log of every tool call and denial.
 *
 * Answers the one question a user of a desktop MCP needs answered:
 * "what did the agent just do?" One line per call, written synchronously
 * (stdio MCP is low-QPS; ordering matters more than throughput). Fail-open:
 * a broken audit must never break the desktop tool it records.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AuditEntry {
  ts: string;
  tool: string;
  args: unknown;
  windowClass: string | null;
  denied: boolean;
  rule: string | null;
  ok: boolean;
}

export class AuditLog {
  private warned = false;
  constructor(readonly file: string) {}

  append(entry: AuditEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        console.error(`hyprland-mcp: audit write failed (${this.file}): ${(e as Error).message}`);
      }
    }
  }

  path(): string {
    return this.file;
  }
}
