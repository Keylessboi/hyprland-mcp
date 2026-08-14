/**
 * Screenshot tool — the only sanctioned capture path.
 *
 * Window capture prefers grim -T (occluded windows, zero perturbation) with
 * geometry-crop fallback. Every capture is written to config.screenshotDir so
 * a text-only model can hand the path to a vision subagent.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { HyprError, err, ok } from '../types.js';
import { assertNotLocked } from '../lock.js';
import { LogicalRect } from '../geometry.js';
import { resolveUnique, targetSchema } from './window-addressing.js';
import { unionRegion } from './screen-region.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gatedRegister, type ToolPolicy } from './guard.js';

type GatedRegister = typeof gatedRegister;

// The file lets a text-only model hand the image to a vision subagent via
// `read`; the tool also keeps the inline image for vision-capable models.
async function writeScreenshot(dir: string, format: string, addressOrTag: string, data: Buffer, mime: string): Promise<string> {
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tag = addressOrTag.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(dir, `${stamp}_${format}${tag ? '_' + tag : ''}.${ext}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, data);
  return file;
}

export function registerScreenshotTools(server: McpServer, deps: ServerDeps, gatedRegister: GatedRegister): void {
  const { ipc, state, screenshots, config } = deps;

  gatedRegister(
    server,
    deps,
    'screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture the screen, a monitor, a window, or a region. Window capture prefers grim -T (occluded windows, zero perturbation) with geometry-crop fallback. Returns the image as inline MCP content plus a file path (for a vision subagent) and coordinate mapping. NEVER run grim or slurp yourself: this tool is the only sanctioned capture path — it handles occluded windows and never disturbs the app.',
      inputSchema: z.object({
        target: z.enum(['screen', 'window', 'region']).default('screen'),
        window: targetSchema.optional(),
        geometry: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(),
        jpeg: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: true },
    },
    { caps: ['screenshot'], mutating: false, windowTouching: true, observation: true },
    async ({ target, window, geometry, jpeg }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        const monitors = (await ipc.json<{ x: number; y: number; width: number; height: number }[]>('monitors')).map((m) => ({ x: m.x, y: m.y, w: m.width, h: m.height }));

        if (target === 'window') {
          if (!window) throw new HyprError('INVALID_ARGUMENTS', 'screenshot target=window requires a window selector');
          const { address } = await resolveUnique(deps, window, 'screenshot');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'window vanished before capture');
          if (w.stableId) {
            try {
              const cap = await screenshots.toplevel(w.stableId);
              const b64 = cap.data.toString('base64');
              const file = await writeScreenshot(config.screenshotDir, 'toplevel', address, cap.data, cap.mime);
              return {
                content: [
                  { type: 'text', text: JSON.stringify({ format: 'toplevel', address, stableId: w.stableId, empty: cap.empty, region: w.at.concat(w.size), file }) },
                  { type: 'image', data: b64, mimeType: cap.mime },
                ],
                structuredContent: ok('screenshot', { format: 'toplevel', address, geometry: { at: w.at, size: w.size }, empty: cap.empty, file }, start),
              } as const;
            } catch {
              // fall through to geometry crop
            }
          }
          const rect: LogicalRect = { x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] };
          const cap = await screenshots.region(rect, { jpeg });
          const b64 = cap.data.toString('base64');
          const mime = cap.mime;
          const file = await writeScreenshot(config.screenshotDir, 'window', address, cap.data, mime);
          return {
            content: [
              { type: 'text', text: JSON.stringify({ format: 'region', address, geometry: rect, empty: cap.empty, file }) },
              { type: 'image', data: b64, mimeType: mime },
            ],
            structuredContent: ok('screenshot', { format: 'region', address, geometry: rect, empty: cap.empty, file }, start),
          } as const;
        }

        if (target === 'region') {
          if (!geometry) throw new HyprError('INVALID_ARGUMENTS', 'screenshot target=region requires geometry {x,y,w,h}');
          const cap = await screenshots.region(geometry, { jpeg });
          const file = await writeScreenshot(config.screenshotDir, 'region', '', cap.data, cap.mime);
          return {
            content: [
              { type: 'text', text: JSON.stringify({ format: 'region', geometry, empty: cap.empty, file }) },
              { type: 'image', data: cap.data.toString('base64'), mimeType: cap.mime },
            ],
            structuredContent: ok('screenshot', { format: 'region', geometry, empty: cap.empty, file }, start),
          } as const;
        }

        // screen = union of monitors
        const screen = unionRegion(monitors);
        const cap = await screenshots.region(screen, { jpeg });
        const file = await writeScreenshot(config.screenshotDir, 'screen', '', cap.data, cap.mime);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ format: 'screen', geometry: screen, empty: cap.empty, file }) },
            { type: 'image', data: cap.data.toString('base64'), mimeType: cap.mime },
          ],
          structuredContent: ok('screenshot', { format: 'screen', empty: cap.empty, file }, start),
        } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('screenshot', e, start)) }], isError: true, structuredContent: err('screenshot', e, start) } as const;
      }
    },
  );
}
