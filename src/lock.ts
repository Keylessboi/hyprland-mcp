/**
 * Session-lock guard.
 *
 * Hyprland exposes `hyprctl locked` -> "true"/"false" from the compositor's
 * own session-lock manager. The MCP uses it to refuse screenshots and input
 * while the screen is locked: under hyprlock the seat focus is the lock
 * surface, so a "click" lands on the lock screen and typed text can enter the
 * password field.
 *
 * Fails closed: if the query itself errors, we cannot confirm the session is
 * safe, so we refuse the action.
 */
import { HyprIpc } from './ipc.js';
import { HyprError } from './types.js';

export async function assertNotLocked(ipc: HyprIpc): Promise<void> {
  let locked: boolean;
  try {
    const res = await ipc.json<{ locked: boolean }>('locked');
    locked = res.locked;
  } catch {
    throw new HyprError('SESSION_LOCKED', 'cannot confirm the session is unlocked; refusing to act on a possibly locked desktop', {
      hint: 'Unlock the screen, then retry.',
      recoverable: true,
    });
  }
  if (locked) {
    throw new HyprError('SESSION_LOCKED', 'the desktop is locked; screenshots and input are refused while locked', {
      hint: 'Unlock the screen, then retry.',
      recoverable: true,
    });
  }
}
