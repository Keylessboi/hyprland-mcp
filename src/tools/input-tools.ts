/**
 * Input tools — focus-guarded clicks, typing, key chords, paste, drag,
 * clipboard read. The safety core: every path either verifies focus through
 * the compositor or uses sendshortcut/sendclick without stealing focus.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import { runCommand } from '../index.js';
import { HyprError, err, ok } from '../types.js';
import { assertNotLocked } from '../lock.js';
import { resolveUnique, targetSchema } from './window-addressing.js';
import { probeSendclick } from './sendclick.js';
import { gatedRegister, type ToolPolicy } from './guard.js';

type GatedRegister = typeof gatedRegister;

export function registerInputTools(server: McpServer, deps: ServerDeps, gatedRegister: GatedRegister): void {
  const { ipc, state, input, config } = deps;

  gatedRegister(
    server,
    deps,
    'input_click',
    {
      title: 'Click mouse',
      description: 'Move the cursor to a coordinate and click. With a target window, clicks the center of that window. If the window is on a non-active workspace, toggles the special workspace overlay transparently (under 1s, workspace state preserved). Pass via_overlay: false to disable auto-overlay. NEVER use ydotool or hyprctl dispatch movecursor yourself: this tool is focus-guarded and workspace-safe.',
      inputSchema: z.object({
        x: z.number().optional().describe('Logical coordinate x (if no target)'),
        y: z.number().optional().describe('Logical coordinate y (if no target)'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
        target: targetSchema.optional(),
        via_overlay: z.boolean().default(true).describe('If target is on another workspace, use special workspace overlay to make it visible'),
      }),
      annotations: { destructiveHint: true },
    },
    { caps: ['input'], mutating: true, windowTouching: true },
    async ({ x, y, button, target, via_overlay }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        // Fast path: with the hyprland-mcp-click plugin loaded, a single atomic
        // `sendclick` dispatch handles both visible and hidden windows (flash-free
        // overlay, workspace restore, no ydotool). The plugin clicks the window
        // center; via_overlay:false keeps the legacy behavior instead.
        if (target !== undefined && via_overlay && (await probeSendclick(ipc))) {
          const { address } = await resolveUnique(deps, target, 'input_click');
          await ipc.dispatch(['sendclick', `address:${address},button:${button}`]);
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          const cx = w ? Math.round(w.at[0] + w.size[0] / 2) : undefined;
          const cy = w ? Math.round(w.at[1] + w.size[1] / 2) : undefined;
          return { content: [{ type: 'text', text: JSON.stringify({ x: cx, y: cy, button, address, plugin: true }) }], structuredContent: ok('input_click', { x: cx, y: cy, button, plugin: true }, start) } as const;
        }
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_click');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'target window vanished');
          const cx = Math.round(w.at[0] + w.size[0] / 2);
          const cy = Math.round(w.at[1] + w.size[1] / 2);

          const activeWs = s.monitors.find((m) => m.focused)?.activeWorkspace?.id;
          const onActive = activeWs !== undefined && w.workspace.id === activeWs;
          const needsOverlay = via_overlay && !onActive;
          const origWs = w.workspace.id;

          if (needsOverlay) {
            await ipc.dispatch(['movetoworkspacesilent', 'special:mcp-click', `address:${address}`]);
            await ipc.dispatch(['togglespecialworkspace', 'mcp-click']);
          }
          await ipc.dispatch(['focuswindow', `address:${address}`]);
          await new Promise((r) => setTimeout(r, 200));
          await input.moveCursor(cx, cy);
          await input.click(button);

          if (needsOverlay) {
            await ipc.dispatch(['togglespecialworkspace', 'mcp-click']);
            await ipc.dispatch(['movetoworkspacesilent', String(origWs), `address:${address}`]);
          }
          return { content: [{ type: 'text', text: JSON.stringify({ x: cx, y: cy, button, address, overlay: needsOverlay }) }], structuredContent: ok('input_click', { x: cx, y: cy, button, overlay: needsOverlay }, start) } as const;
        }
        const clickX = x ?? 0;
        const clickY = y ?? 0;
        await input.moveCursor(Math.round(clickX), Math.round(clickY));
        await input.click(button);
        return { content: [{ type: 'text', text: JSON.stringify({ x: clickX, y: clickY, button }) }], structuredContent: ok('input_click', { x: clickX, y: clickY, button }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_click', e, start)) }], isError: true, structuredContent: err('input_click', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'input_type',
    {
      title: 'Type text',
      description: 'Type ASCII text into the focused window via wtype. Unicode/CJK requires input_paste. Focus guard applies. NEVER run wtype yourself: this tool verifies focus first so input cannot go to the wrong window.',
      inputSchema: z.object({ text: z.string(), target: targetSchema.optional() }),
      annotations: { destructiveHint: true },
    },
    { caps: ['input'], mutating: true, windowTouching: true },
    async ({ text, target }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_type');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'target window vanished');
          // ensure focused — focus guard will verify
          await ipc.dispatch(['focuswindow', `address:${address}`]);
          await new Promise((r) => setTimeout(r, 150));
          await input.typeText(text, address);
        } else {
          await input.typeText(text);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ typed: text.length, chars: text.length }) }], structuredContent: ok('input_type', { chars: text.length }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_type', e, start)) }], isError: true, structuredContent: err('input_type', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'input_key',
    {
      title: 'Send key chord',
      description: 'Send a key chord (e.g. ctrl+alt+t) to the focused window, or per-window via sendshortcut without focus change (probe-gated).',
      inputSchema: z.object({
        chord: z.string(),
        target: targetSchema.optional().describe('If given, sendshortcut to this window without stealing focus'),
        mods: z.array(z.string()).optional().describe('Modifiers for sendshortcut mode: ["CTRL","SHIFT"]'),
      }),
      annotations: { destructiveHint: true },
    },
    { caps: ['input'], mutating: true, windowTouching: true },
    async ({ chord, target, mods }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        if (target !== undefined && mods) {
          const { address } = await resolveUnique(deps, target, 'input_key');
          const key = chord.toLowerCase();
          await input.sendShortcutToWindow(mods, key, address);
          return { content: [{ type: 'text', text: JSON.stringify({ mode: 'sendshortcut', window: address, chord }) }], structuredContent: ok('input_key', { mode: 'sendshortcut', chord }, start) } as const;
        }
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_key');
          const s = await state.snapshot();
          const w = s.clients.find((c) => c.address === address);
          if (!w) throw new HyprError('WINDOW_NOT_FOUND', 'target window vanished');
          await ipc.dispatch(['focuswindow', `address:${address}`]);
          await new Promise((r) => setTimeout(r, 150));
          await input.keyChord(chord, address);
          return { content: [{ type: 'text', text: JSON.stringify({ mode: 'focused', window: address, chord }) }], structuredContent: ok('input_key', { mode: 'focused', chord }, start) } as const;
        }
        await input.keyChord(chord);
        return { content: [{ type: 'text', text: JSON.stringify({ mode: 'focused', chord }) }], structuredContent: ok('input_key', { mode: 'focused', chord }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_key', e, start)) }], isError: true, structuredContent: err('input_key', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'input_paste',
    {
      title: 'Paste text (Unicode path)',
      description: 'Paste text via wl-copy + Ctrl+V. With a target window, uses sendshortcut (no focus steal — works on background windows). Without target, pastes into the currently focused window. Permission-gated. NEVER run wl-copy or wl-paste yourself: this tool is focus-guarded and gated.',
      inputSchema: z.object({ text: z.string(), target: targetSchema.optional() }),
      annotations: { destructiveHint: true },
    },
    { caps: ['input'], mutating: true, windowTouching: true },
    async ({ text, target }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        if (!config.allowClipboardPaste) {
          throw new HyprError('PERMISSION_DENIED', 'clipboard paste disabled in config');
        }
        await runCommand('wl-copy', ['--', text]);
        if (target !== undefined) {
          const { address } = await resolveUnique(deps, target, 'input_paste');
          await input.sendShortcutToWindow(['CTRL'], 'V', address);
          return { content: [{ type: 'text', text: JSON.stringify({ pasted: text.length, mode: 'sendshortcut', window: address }) }], structuredContent: ok('input_paste', { chars: text.length, mode: 'sendshortcut' }, start) } as const;
        }
        await input.keyChord('ctrl+v');
        return { content: [{ type: 'text', text: JSON.stringify({ pasted: text.length, mode: 'focused' }) }], structuredContent: ok('input_paste', { chars: text.length, mode: 'focused' }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_paste', e, start)) }], isError: true, structuredContent: err('input_paste', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'input_drag',
    {
      title: 'Mouse drag',
      description: 'Drag the mouse from one coordinate to another. Uses movecursor for positioning + ydotool mousedown/move/mouseup.',
      inputSchema: z.object({
        start_x: z.number(), start_y: z.number(),
        end_x: z.number(), end_y: z.number(),
        button: z.enum(['left', 'right']).default('left'),
      }),
      annotations: { destructiveHint: true },
    },
    { caps: ['input'], mutating: true },
    async ({ start_x, start_y, end_x, end_y, button }) => {
      const start = Date.now();
      try {
        await assertNotLocked(ipc);
        await input.drag(start_x, start_y, end_x, end_y, button);
        return { content: [{ type: 'text', text: JSON.stringify({ dragged: true, from: [start_x, start_y], to: [end_x, end_y] }) }], structuredContent: ok('input_drag', { from: [start_x, start_y], to: [end_x, end_y] }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('input_drag', e, start)) }], isError: true, structuredContent: err('input_drag', e, start) } as const;
      }
    },
  );

  gatedRegister(
    server,
    deps,
    'clipboard_read',
    {
      title: 'Read clipboard',
      description: 'Read the clipboard text via wl-paste. Permission-gated. The clipboard may contain secrets.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    { caps: ['input'], mutating: false, observation: true },
    async () => {
      const start = Date.now();
      try {
        const out = await runCommand('wl-paste', [], { timeoutMs: 2000 });
        const text = out.stdout.trim();
        return { content: [{ type: 'text', text: text }], structuredContent: ok('clipboard_read', { length: text.length }, start) } as const;
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify(err('clipboard_read', e, start)) }], isError: true, structuredContent: err('clipboard_read', e, start) } as const;
      }
    },
  );
}
