/**
 * Screenshot — capture ladder (adversary, verified live):
 *   1. grim -T <stableId>   — occluded/background windows (0.47+, zero perturbation)
 *   2. grim -g geometry     — visible-unfocused windows / monitors / regions
 *   3. (last resort, caller-side) bring-to-front + grim -g
 * grim -t jpeg native since 1.4; sharp only for resize in the tool layer.
 */
import { spawn } from 'node:child_process';
import { HyprError } from './types.js';
import { LogicalRect, buildCoordMapping, MonitorGeometry, grimGeometry } from './geometry.js';

export interface ScreenshotResult {
  /** raw bytes (PNG or JPEG) */
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
  format: 'toplevel' | 'region' | 'monitor';
  region: LogicalRect;
  mapping: ReturnType<typeof buildCoordMapping>;
  /** null when capture produced no bytes */
  empty: boolean;
}

export interface ScreenshotBackend {
  run(bin: string, args: string[], opts?: { timeoutMs?: number }): Promise<{ stdout: Buffer; stderr: string; code: number | null }>;
}

export class RealCommandRunner implements ScreenshotBackend {
  run(bin: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      // Inject the Wayland session env so grim/wl-copy work even when the
      // server runs outside a full session (systemd service, VM, ssh).
      const env = {
        ...process.env,
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? 'wayland-1',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`,
      };
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
      const out: Buffer[] = [];
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new HyprError('SCREENSHOT_FAILED', `${bin} timed out`, { recoverable: true }));
      }, opts.timeoutMs ?? 10_000);
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString('utf8');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out), stderr: err, code });
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === 'ENOENT') {
          reject(new HyprError('MISSING_BINARY', `${bin} not found`, {
            hint: `Install ${bin} (Arch: sudo pacman -S ${bin})`,
          }));
        } else {
          reject(new HyprError('SCREENSHOT_FAILED', `${bin} failed: ${e.message}`, { recoverable: true }));
        }
      });
    });
  }
}

/** Tiny PNG probe: non-empty and starts with the PNG magic. */
export function isPlausiblePng(data: Buffer): boolean {
  return data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
}

export class Screenshotter {
  constructor(
    private runner: ScreenshotBackend,
    private monitors: MonitorGeometry[],
  ) {}

  /**
   * Capture a toplevel by stableId. Zero perturbation of the app.
   * Hangs on some scroll-layout-hidden windows (#13710) → hard timeout.
   */
  async toplevel(stableId: string, timeoutMs = 5000): Promise<ScreenshotResult> {
    const { stdout, code } = await this.runner.run('grim', ['-t', 'jpeg', '-T', stableId, '-'], { timeoutMs });
    if (code !== 0 && code !== null) {
      throw new HyprError('SCREENSHOT_FAILED', `grim -T returned ${code}`, {
        hint: 'toplevel export unavailable — fall back to grim -g geometry crop',
        recoverable: true,
      });
    }
    // -T returns the surface at native res with NO on-screen position.
    // region is unknown; caller must pair with clients -j geometry for clicks.
    return {
      data: stdout,
      mime: 'image/jpeg',
      format: 'toplevel',
      region: { x: 0, y: 0, w: 0, h: 0 },
      mapping: buildCoordMapping({ x: 0, y: 0, w: 0, h: 0 }, this.monitors, 1),
      empty: stdout.length === 0 || !isPlausiblePng(stdout) && stdout.length < 100,
    };
  }

  /** Geometry crop (grim -g). For visible windows, monitors, regions. */
  async region(rect: LogicalRect, opts?: { jpeg?: boolean; timeoutMs?: number }): Promise<ScreenshotResult> {
    const format = opts?.jpeg ?? true;
    const args = format
      ? ['-t', 'jpeg', '-g', grimGeometry(rect), '-']
      : ['-g', grimGeometry(rect), '-'];
    const { stdout, code } = await this.runner.run('grim', args, { timeoutMs: opts?.timeoutMs ?? 10_000 });
    if (code !== 0 && code !== null) {
      throw new HyprError('SCREENSHOT_FAILED', `grim -g returned ${code}`, {
        hint: 'Check region is on a live monitor with output enabled (DPMS?)',
        recoverable: true,
      });
    }
    return {
      data: stdout,
      mime: format ? 'image/jpeg' : 'image/png',
      format: 'region',
      region: rect,
      mapping: buildCoordMapping(rect, this.monitors),
      empty: stdout.length === 0,
    };
  }
}
