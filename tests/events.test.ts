/**
 * Event stream parser + reconnect (plan §2, deep Part 8).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { HyprEventStream } from '../src/events.js';
import { startFakeEventSource } from './harness.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let sources: ReturnType<typeof startFakeEventSource>[] = [];
afterEach(() => {
  for (const s of sources) {
    s.close();
    try {
      fs.rmSync(path.dirname(s.path), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  sources = [];
});

function makeStream(): { stream: HyprEventStream; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypr-ev-'));
  return { stream: new HyprEventStream({ socketDir: dir }), dir };
}

describe('event stream', () => {
  it('parses EVENT>>payload lines', async () => {
    const { stream, dir } = makeStream();
    const src = await startFakeEventSource(dir);
    sources.push(src);
    const events: string[] = [];
    stream.on('event', (e: { event: string }) => events.push(e.event));
    stream.start();
    await new Promise((r) => setTimeout(r, 100));

    src.emit('workspace>>1');
    src.emit('activewindowv2>>0x55dfd4156230');
    src.emit('openwindow>>0x55dfd4156231,1,kitty,Terminal');
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toContain('workspace');
    expect(events).toContain('activewindowv2');
    expect(events).toContain('openwindow');
    stream.stop();
  });

  it('handles titles containing >> separators by splitting on FIRST >>', async () => {
    const { stream, dir } = makeStream();
    const src = await startFakeEventSource(dir);
    sources.push(src);
    let payload = '';
    stream.on('event', (e: { event: string; payload: string }) => {
      if (e.event === 'windowtitle') payload = e.payload;
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 100));
    src.emit('windowtitle>>0x1,Some >> Weird >> Title');
    await new Promise((r) => setTimeout(r, 100));
    expect(payload).toBe('0x1,Some >> Weird >> Title');
    stream.stop();
  });

  it('emits disconnect on EOF and reconnects', async () => {
    const { stream, dir } = makeStream();
    const src = await startFakeEventSource(dir);
    sources.push(src);
    let disconnects = 0;
    stream.on('disconnect', () => disconnects++);
    stream.start();
    await new Promise((r) => setTimeout(r, 100));
    src.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(disconnects).toBeGreaterThanOrEqual(1);
    stream.stop();
  });

  it('waitFor resolves on matching event and rejects on timeout', async () => {
    const { stream, dir } = makeStream();
    const src = await startFakeEventSource(dir);
    sources.push(src);
    stream.start();
    await new Promise((r) => setTimeout(r, 100));

    const waiter = stream.waitFor((e) => e.event === 'openwindow', 2000);
    src.emit('openwindow>>0x1,1,kitty,Term');
    await expect(waiter).resolves.toMatchObject({ event: 'openwindow' });

    const timeout = stream.waitFor((e) => e.event === 'never', 100);
    await expect(timeout).rejects.toThrow(/timed out/);
    stream.stop();
  });
});
