/**
 * Placement verification: `launch` asks Hyprland to open the app on a named
 * workspace, then checks where it actually landed. That check is only as good
 * as its workspace comparison, which has to speak the same selector forms the
 * tool accepts.
 */
import { describe, it, expect } from 'vitest';
import { onWorkspace } from '../src/tools/window-tools.js';

const client = (id: number, name: string) => ({ workspace: { id, name } });

describe('onWorkspace', () => {
  it('matches a named workspace by its name, not its synthetic id', () => {
    // Hyprland gives named workspaces a -1337-class id, so only the name is stable.
    expect(onWorkspace(client(-1337, 'agent'), 'name:agent')).toBe(true);
    expect(onWorkspace(client(-1337, 'agent'), 'name:other')).toBe(false);
  });

  it('matches a numeric workspace by id', () => {
    expect(onWorkspace(client(2, '2'), '2')).toBe(true);
    expect(onWorkspace(client(3, '3'), '2')).toBe(false);
  });

  it('matches a special workspace by its full name', () => {
    expect(onWorkspace(client(-99, 'special:magic'), 'special:magic')).toBe(true);
    expect(onWorkspace(client(-99, 'special:other'), 'special:magic')).toBe(false);
  });

  it('does not confuse a workspace named "2" with workspace id 2', () => {
    expect(onWorkspace(client(-1337, '2'), 'name:2')).toBe(true);
    expect(onWorkspace(client(-1337, '2'), '2')).toBe(false);
  });
});
