/**
 * OCR tools — read text on screen, click text, wait for conditions.
 *
 * The desktop-interaction loop: capture (toplevel-preferred), OCR, coordinate
 * math (pixel → logical via monitor scale), then a guarded click.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { HyprError, err, ok, okObserved } from '../types.js';
import { assertNotLocked } from '../lock.js';
import { LogicalRect } from '../geometry.js';
import type { ScreenshotResult } from '../screenshot.js';
import { resolveUnique, targetSchema } from './window-addressing.js';
import { probeSendclick } from './sendclick.js';
import { unionRegion } from './screen-region.js';
import { gatedRegister, type ToolPolicy } from './guard.js';

type GatedRegister = typeof gatedRegister;

// Capture a window for OCR / click targeting. Prefers grim -T (toplevel
// export): it captures the window surface even when the window is on another
// workspace or occluded, WITHOUT switching the user's workspace or disturbing
// the app. Falls back to grim -g region crop when -T is unavailable.
async function captureWindowForTarget(
  screenshots: { toplevel: (id: string, timeoutMs?: number) => Promise<ScreenshotResult>; region: (r: LogicalRect, opts?: { jpeg?: boolean; timeoutMs?: number }) => Promise<ScreenshotResult> },
  w: { stableId?: string; at: [number, number]; size: [number, number] },
  regionCapture: () => Promise<ScreenshotResult>,
): Promise<{ cap: ScreenshotResult; region: LogicalRect }> {
  const region: LogicalRect = { x: w.at[0]!, y: w.at[1]!, w: w.size[0]!, h: w.size[1]! };
  if (w.stableId) {
    try {
      const cap = await screenshots.toplevel(w.stableId);
      return { cap, region };
    } catch {
      // fall through to region crop
    }
  }
  return { cap: await regionCapture(), region };
}

export function registerOcrTools(server: McpServer, deps: ServerDeps, gatedRegister: GatedRegister): void {
  const { ipc, state, screenshots, ocr, input } = deps;

  gatedRegister(
    server,
    deps,
    'read_text_on_screen',
    {
      title: 'Read text on screen',
      description: 'OCR a window, region, or the screen and return the visible text plus word boxes (pixel and logical coordinates). Use this to learn what text an app shows before targeting it with click_text or wait_for. Requires tesseract. The lock guard applies.',
      inputSchema: z.object({
        target: z.enum(['screen', 'window', 'region']).default('screen'),
        window: targetSchema.optional(),
        geometry: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        language: z.string().default('eng').describe('tesseract language code (e.g. eng, osd). Only installed languages work.'),
      }),
      annotations: { readOnlyHint: true },
    },
    { caps: ['screenshot'], mutating: false, windowTouching: true, observation: true },
    async ({ target, window, geometry, language }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height, scale: m.scale }));
        const scaleOf = (rect: LogicalRect) => {
          const m = monitors.find((mo) => mo.x === rect.x && mo.y === rect.y) ?? monitors.find((mo) => rect.x >= mo.x && rect.x < mo.x + mo.w && rect.y >= mo.y && rect.y < mo.y + mo.h);
          return m?.scale ?? 1;
        };

        let cap: Awaited<ReturnType<typeof screenshots.region>>;
        let origin: { x: number; y: number };
        let region: LogicalRect;

        if (target === 'window') {
          if (!window) throw new HyprError('INVALID_ARGUMENTS', 'read_text_on_screen target=window requires a window selector');
          const { address } = await resolveUnique(deps, window, 'read_text_on_screen');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'window vanished before capture');
          const captured = await captureWindowForTarget(screenshots, w, () => screenshots.region({ x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] }));
          cap = captured.cap;
          region = captured.region;
          origin = { x: region.x, y: region.y };
        } else if (target === 'region') {
          if (!geometry) throw new HyprError('INVALID_ARGUMENTS', 'read_text_on_screen target=region requires geometry {x,y,w,h}');
          region = geometry;
          origin = { x: geometry.x, y: geometry.y };
          cap = await screenshots.region(geometry);
        } else {
          region = unionRegion(monitors);
          origin = { x: region.x, y: region.y };
          cap = await screenshots.region(region);
        }

        const scale = scaleOf(region);
        const { text, words } = await ocr.readImage(cap.data, { language });
        const boxes = words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          pixel: { left: word.left, top: word.top, width: word.width, height: word.height },
          logical: { x: origin.x + word.left / scale, y: origin.y + word.top / scale, w: word.width / scale, h: word.height / scale },
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ format: target, text, wordCount: boxes.length, region }) }],
          structuredContent: okObserved('read_text_on_screen', { format: target, text, words: boxes, region }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('read_text_on_screen', e, start)) }], isError: true, structuredContent: err('read_text_on_screen', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'click_text',
    {
      title: 'Click text on screen',
      description: 'Find a text string on screen (OCR) and click its center. One call replaces screenshot + vision + coordinate math. Optionally scope to a window; optionally choose which match when the text appears several times. Uses the same focused/guarded input path as input_click.',
      inputSchema: z.object({
        text: z.string().describe('The text to find (substring match on OCR words)'),
        window: targetSchema.optional().describe('Scope the search to this window'),
        match: z.number().int().default(0).describe('Which match to click when the text appears multiple times (0 = first)'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
      }),
      annotations: { destructiveHint: true },
    },
    { caps: ['screenshot', 'input'], mutating: true, windowTouching: true },
    async ({ text, window, match, button }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        const { address } = window !== undefined ? await resolveUnique(deps, window, 'click_text') : { address: undefined as string | undefined };
        const s = window !== undefined ? await state.snapshot() : undefined;
        const w = window !== undefined ? s!.clients.find((c) => c.address === address) : undefined;
        if (window !== undefined && !w) throw new HyprError('WINDOW_NOT_FOUND', 'window vanished before capture');

        const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number; scale: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height, scale: m.scale }));
        const region: LogicalRect = window !== undefined && w ? { x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] } : unionRegion(monitors);
        const cap = window !== undefined && w
          ? (await captureWindowForTarget(screenshots, w, () => screenshots.region({ x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] }))).cap
          : await screenshots.region(region);
        const mo = monitors.find((m) => region.x >= m.x && region.x < m.x + m.w && region.y >= m.y && region.y < m.y + m.h) ?? monitors[0];
        const scale = mo?.scale ?? 1;
        const { words } = await ocr.readImage(cap.data);
        const needle = text.toLowerCase();
        const hits = words.filter((word) => word.text.toLowerCase().includes(needle));
        if (hits.length === 0) {
          throw new HyprError('TEXT_NOT_FOUND', `no match for "${text}" on ${window !== undefined ? 'window ' + address : 'screen'}`, {
            hint: 'Run read_text_on_screen first to see the actual text on screen.',
            recoverable: true,
          });
        }
        if (match >= hits.length) {
          throw new HyprError('TEXT_NOT_FOUND', `match ${match} out of range: "${text}" found ${hits.length} time(s)`, { recoverable: true });
        }
        const hit = hits[match]!;
        const clickX = Math.round(region.x + (hit.left + hit.width / 2) / scale);
        const clickY = Math.round(region.y + (hit.top + hit.height / 2) / scale);

        if (window !== undefined && address && (await probeSendclick(ipc))) {
          await ipc.dispatch(['sendclick', `address:${address},button:${button},x:${clickX},y:${clickY}`]);
        } else {
          await ipc.dispatch(['movecursor', String(clickX), String(clickY)]);
          await input.click(button);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ text, clicked: { x: clickX, y: clickY }, address: address ?? null }) }], structuredContent: ok('click_text', { text, x: clickX, y: clickY, address: address ?? null }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('click_text', e, start)) }], isError: true, structuredContent: err('click_text', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'wait_for',
    {
      title: 'Wait for condition',
      description: 'Block until a condition becomes true: text on screen (OCR), a window appearing, or a workspace becoming active. Polls the desktop; returns as soon as the condition holds or times out. Replaces agent sleep-and-poll loops.',
      inputSchema: z.object({
        text: z.string().optional().describe('Wait until this text appears on screen (OCR). Note: OCR on the whole screen is slow; prefer window-scoped waits.'),
        window: targetSchema.optional().describe('Wait until this window exists'),
        active_workspace: z.number().int().optional().describe('Wait until this workspace is active'),
        timeout_ms: z.number().int().default(15000),
        poll_ms: z.number().int().default(500),
      }),
      annotations: { readOnlyHint: true },
    },
    { caps: ['screenshot'], mutating: false, observation: true },
    async ({ text, window, active_workspace, timeout_ms, poll_ms }) => {
      const start = Date.now();
      try {
        if (text === undefined && window === undefined && active_workspace === undefined) {
          throw new HyprError('INVALID_ARGUMENTS', 'wait_for needs at least one of text, window, or active_workspace');
        }
        const deadline = Date.now() + timeout_ms;
        while (Date.now() < deadline) {
          if (window !== undefined) {
            const hits = await deps.state.resolveWindow(window);
            if (hits.length > 0) {
              return { content: [{ type: 'text', text: JSON.stringify({ matched: 'window', window: hits[0]!.address }) }], structuredContent: ok('wait_for', { matched: 'window', address: hits[0]!.address, ms: Date.now() - start }, start) } as const;
            }
          }
          if (active_workspace !== undefined) {
            const s = await state.snapshot();
            const active = s.monitors.find((m) => m.focused)?.activeWorkspace?.id;
            if (active === active_workspace) {
              return { content: [{ type: 'text', text: JSON.stringify({ matched: 'workspace', id: active_workspace }) }], structuredContent: ok('wait_for', { matched: 'workspace', id: active_workspace, ms: Date.now() - start }, start) } as const;
            }
          }
          if (text !== undefined) {
            // OCR the focused window if possible, else the screen
            const s = await state.snapshot();
            const focused = s.clients.find((c) => c.address === s.activeWindow?.address);
            const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height }));
            const region: LogicalRect = focused ? { x: focused.at[0], y: focused.at[1], w: focused.size[0], h: focused.size[1] } : unionRegion(monitors);
            const cap = await screenshots.region(region);
            const { words } = await ocr.readImage(cap.data);
            if (words.some((word) => word.text.toLowerCase().includes(text.toLowerCase()))) {
              return { content: [{ type: 'text', text: JSON.stringify({ matched: 'text', text }) }], structuredContent: okObserved('wait_for', { matched: 'text', text, ms: Date.now() - start }, start) } as const;
            }
          }
          await new Promise((r) => setTimeout(r, poll_ms));
        }
        throw new HyprError('WAIT_TIMEOUT', `condition not met within ${timeout_ms}ms`, { recoverable: true });
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('wait_for', e, start)) }], isError: true, structuredContent: err('wait_for', e, start) } as const;
      }
    },
  );
}
