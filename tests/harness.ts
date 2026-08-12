/**
 * Fake Hyprland harness (deep Part 8): a real UNIX socket answering canned
 * JSON per command, plus a scripted socket2 event emitter.
 *
 * This is NOT a mock library — it is a minimal in-process Hyprland that speaks
 * the actual wire protocol (request line → response, EOF closes) so the IPC
 * contract, serialization, timeouts, and parser are tested for real.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface FakeHyprlandOptions {
  /** Command → response text. Can return a Promise for timing tests. */
  respond: Record<string, string | ((req: string) => string | Promise<string>)>;
  /** Whether to honor the freeze-contract: close after each response (default true). */
  closeAfterResponse?: boolean;
  /** Delay before responding (ms). */
  delayMs?: number;
  /** If true, never respond (for timeout tests). */
  hang?: boolean;
}

export interface FakeHyprland {
  dir: string;
  socketPath: string;
  /** The live respond map; tests can add/mutate command responses. */
  respond: Record<string, string | ((req: string) => string | Promise<string>)>;
  /** Number of connections accepted (proves connect-per-request). */
  connectionCount(): number;
  /** Commands received in order. */
  received(): string[];
  close(): void;
}

export function startFakeHyprland(opts: FakeHyprlandOptions & { socketDir?: string }): FakeHyprland {
  const dir = opts.socketDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-fake-'));
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, '.socket.sock');
  let connections = 0;
  const received: string[] = [];
  const emitter = new EventEmitter();

  const server = net.createServer((sock) => {
    connections++;
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        received.push(line);
        handle(line, sock);
      }
    });
  });

  function handle(line: string, sock: net.Socket): void {
    if (opts.hang) return; // never respond — timeout test
    const send = (text: string) => {
      setTimeout(() => {
        sock.write(text + '\n');
        if (opts.closeAfterResponse !== false) sock.end();
      }, opts.delayMs ?? 0);
    };

    // exact match first, then prefix dispatch
    if (line in opts.respond) {
      const r = opts.respond[line]!;
      if (typeof r === 'function') {
        Promise.resolve(r(line)).then((v) => send(v)).catch(() => send('error'));
      } else {
        send(r);
      }
      return;
    }
    for (const [k, v] of Object.entries(opts.respond)) {
      if (k.endsWith('*') && line.startsWith(k.slice(0, -1))) {
        const r = v;
        if (typeof r === 'function') {
          Promise.resolve(r(line)).then((res) => send(res)).catch(() => send('error'));
        } else {
          send(r);
        }
        return;
      }
    }
    send('unknown command');
  }

  return new Promise<FakeHyprland>((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        dir,
        socketPath,
        respond: opts.respond,
        connectionCount: () => connections,
        received: () => [...received],
        close: () => {
          server.close();
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        },
      });
    });
  });
}

/** Scripted socket2 emitter for event-parser tests. */
export function startFakeEventSource(dir: string): { path: string; emit(line: string): void; close(): void } {
  const socketPath = path.join(dir, '.socket2.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        path: socketPath,
        emit(line: string) {
          for (const s of sockets) s.write(line + '\n');
        },
        close() {
          server.close();
          for (const s of sockets) s.destroy();
        },
      });
    });
  });
}
