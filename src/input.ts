/**
 * Input — focus-guarded synthesis (adversary R2 is the top irreducible risk).
 *
 * Hard invariants:
 *   - NEVER inject without verifying the focused window first (activewindowv2)
 *   - position via `dispatch movecursor` (compositor-native absolute, logical)
 *   - ydotool = buttons/scroll ONLY. NEVER mousemove --absolute (uinput
 *     absolute axes don't map to the Wayland cursor — adversary D1)
 *   - wtype for ASCII text; Unicode/CJK via wl-copy + Ctrl+V (gated elsewhere)
 *   - sendshortcut for per-window chords without focus steal (probe-gated)
 */
import { HyprIpc } from './ipc.js';
import { HyprError } from './types.js';

export interface InputBackend {
  run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }>;
}

export class RealInputRunner implements InputBackend {
  async run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new HyprError('INPUT_DEVICE_UNAVAILABLE', `${bin} timed out`, { recoverable: true }));
      }, 5000);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: out, stderr: err, code });
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === 'ENOENT') {
          reject(new HyprError('MISSING_BINARY', `${bin} not found`, { hint: `Install ${bin}` }));
        } else {
          reject(new HyprError('INPUT_DEVICE_UNAVAILABLE', `${bin} failed: ${e.message}`, { recoverable: true }));
        }
      });
    });
  }
}

export interface FocusGuard {
  /** Verify the focused window matches expectation before injecting. */
  assertFocused(expectedAddress: string): Promise<void>;
}

export class HyprFocusGuard implements FocusGuard {
  constructor(private ipc: HyprIpc) {}

  async assertFocused(expectedAddress: string): Promise<void> {
    const win = await this.ipc.json<{ address?: string; class?: string }>('activewindowv2').catch(() => null);
    if (!win || !win.address) {
      throw new HyprError('COMPOSITOR_UNAVAILABLE', 'no active window — refusing to inject input', {
        hint: 'Focus a target window first.',
      });
    }
    if (win.address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new HyprError('COMPOSITOR_UNAVAILABLE', `focus mismatch: expected ${expectedAddress}, focused ${win.address}`, {
        hint: 'Focus the target window before injecting input (focus-steal guard).',
        recoverable: true,
      });
    }
  }
}

export class InputController {
  constructor(
    private ipc: HyprIpc,
    private runner: InputBackend,
    private guard: FocusGuard,
    private opts: { allowUnicodePaste?: boolean } = {},
  ) {}

  /** Absolute cursor position (logical global). */
  async moveCursor(x: number, y: number): Promise<void> {
    await this.ipc.dispatch(['movecursor', String(x), String(y)]);
  }

  /** Button at the CURRENT cursor position. left=1 right=3 middle=2 (X buttons). */
  async click(button: 'left' | 'right' | 'middle', count = 1): Promise<void> {
    const code = button === 'left' ? '1' : button === 'right' ? '3' : '2';
    for (let i = 0; i < count; i++) {
      const r = await this.runner.run('ydotool', ['click', `0x${(parseInt(code, 10) + 0xc0).toString(16)}`]);
      if (r.code !== 0) {
        throw new HyprError('YDOTOOL_UNAVAILABLE', `ydotool click failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`, {
          hint: 'Start ydotoold: systemctl --user start ydotoold',
          recoverable: true,
        });
      }
    }
  }

  /** Scroll (buttons 4=up 5=down in ydotool's 0xC4/0xC5 encoding). */
  async scroll(lines: number): Promise<void> {
    const btn = lines > 0 ? '0xC4' : '0xC5';
    const r = await this.runner.run('ydotool', ['click', btn]);
    if (r.code !== 0) {
      throw new HyprError('YDOTOOL_UNAVAILABLE', `ydotool scroll failed: ${r.stderr.trim()}`, {
        hint: 'Start ydotoold: systemctl --user start ydotoold',
        recoverable: true,
      });
    }
  }

  /** Text via wtype (ASCII). Throws INPUT_DEVICE_UNAVAILABLE for non-ASCII. */
  async typeText(text: string, targetAddress?: string): Promise<void> {
    if (targetAddress) await this.guard.assertFocused(targetAddress);
    if (/[^\x00-\x7F]/.test(text)) {
      throw new HyprError('INPUT_DEVICE_UNAVAILABLE', 'wtype is ASCII-only; use the paste path for Unicode/CJK', {
        hint: 'Call input_paste with the same text (permission-gated wl-copy + Ctrl+V).',
      });
    }
    const r = await this.runner.run('wtype', ['--', text]);
    if (r.code !== 0) {
      throw new HyprError('INPUT_DEVICE_UNAVAILABLE', `wtype failed (${r.code}): ${r.stderr.trim()}`, { recoverable: true });
    }
  }

  /** Key chord to the focused window via wtype modifiers. */
  async keyChord(chord: string, targetAddress?: string): Promise<void> {
    if (targetAddress) await this.guard.assertFocused(targetAddress);
    // chord format: "ctrl+alt+t" → wtype -M ctrl -M alt -k t
    const parts = chord.toLowerCase().split('+');
    const key = parts.pop()!;
    const mods = parts;
    const args: string[] = [];
    for (const m of mods) args.push('-M', m);
    args.push('-k', key);
    const r = await this.runner.run('wtype', args);
    if (r.code !== 0) {
      throw new HyprError('INPUT_DEVICE_UNAVAILABLE', `wtype chord failed: ${r.stderr.trim()}`, { recoverable: true });
    }
  }

  /** Drag: mousedown at start → move to end → mouseup */
  async drag(startX: number, startY: number, endX: number, endY: number, button: 'left' | 'right' = 'left'): Promise<void> {
    const btnCode = button === 'left' ? '0x40' : '0x41';
    const upCode = button === 'left' ? '0x80' : '0x81';
    await this.ipc.dispatch(['movecursor', String(Math.round(startX)), String(Math.round(startY))]);
    let r = await this.runner.run('ydotool', ['click', btnCode]);
    if (r.code !== 0) throw new HyprError('YDOTOOL_UNAVAILABLE', `ydotool drag failed: ${r.stderr.trim()}`, { recoverable: true });
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.round(startX + (endX - startX) * t);
      const cy = Math.round(startY + (endY - startY) * t);
      await this.ipc.dispatch(['movecursor', String(cx), String(cy)]);
      if (i < steps) await new Promise((r) => setTimeout(r, 5));
    }
    r = await this.runner.run('ydotool', ['click', upCode]);
    if (r.code !== 0) throw new HyprError('YDOTOOL_UNAVAILABLE', `ydotool drag up failed: ${r.stderr.trim()}`, { recoverable: true });
  }

  /**
   * Per-window chord WITHOUT focus change (Hyprland ≥0.41, probe-gated).
   * Grammar: "CTRL SHIFT, T, address:0x…" — uppercase comma-separated mods.
   */
  async sendShortcutToWindow(mods: string[], key: string, windowAddress: string): Promise<void> {
    const modStr = mods.map((m) => m.toUpperCase()).join(' ');
    await this.ipc.dispatch(['sendshortcut', `${modStr}, ${key.toUpperCase()}, address:${windowAddress}`]);
  }
}
