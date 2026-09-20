/**
 * Hyprland 0.56 turned `dispatch` into a Lua call. These cover the
 * translation and the detection, which is what keeps focus/close/workspace
 * and workspace-isolated launches working across both versions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatchRequest, isDialectError, resetDispatchDialect, parseExecRules } from '../src/ipc.js';

beforeEach(() => resetDispatchDialect());

describe('dispatchRequest', () => {
  it('sends the classic string form unchanged', () => {
    expect(dispatchRequest(['workspace', 'name:agent'], 'string')).toBe('dispatch workspace name:agent');
    expect(dispatchRequest(['movetoworkspacesilent', 'name:agent,address:0x1'], 'string'))
      .toBe('dispatch movetoworkspacesilent name:agent,address:0x1');
  });

  it('translates each verb into its real hl.dsp call', () => {
    expect(dispatchRequest(['closewindow', 'address:0x1'], 'lua'))
      .toBe('dispatch hl.dsp.window.close({ window = "address:0x1" })');
    expect(dispatchRequest(['workspace', 'name:agent'], 'lua'))
      .toBe('dispatch hl.dsp.focus({ workspace = "name:agent" })');
    expect(dispatchRequest(['focuswindow', 'address:0x1'], 'lua'))
      .toBe('dispatch hl.dsp.focus({ window = "address:0x1" })');
    expect(dispatchRequest(['movecursor', '10', '20'], 'lua'))
      .toBe('dispatch hl.dsp.cursor.move({ x = 10, y = 20 })');
    expect(dispatchRequest(['togglefloating', 'address:0x1'], 'lua'))
      .toBe('dispatch hl.dsp.window.float({ action = "toggle", window = "address:0x1" })');
  });

  // The bug this whole layer exists for: `hl.dsp.global` answers "ok" and
  // moves nothing, so a launch lands on the user's screen with no error.
  it('spells silent placement as follow = false, not a silent key', () => {
    expect(dispatchRequest(['movetoworkspacesilent', 'name:agent,address:0x1'], 'lua'))
      .toBe('dispatch hl.dsp.window.move({ workspace = "name:agent", follow = false, window = "address:0x1" })');
    // the same call arriving as separate argv entries must translate identically
    expect(dispatchRequest(['movetoworkspacesilent', '2', 'address:0x1'], 'lua'))
      .toBe('dispatch hl.dsp.window.move({ workspace = "2", follow = false, window = "address:0x1" })');
  });

  it('turns an exec window-rule prefix into the exec_cmd rule table', () => {
    expect(dispatchRequest(['exec', '[workspace name:agent silent] foot'], 'lua'))
      .toBe('dispatch hl.dsp.exec_cmd("foot", { workspace = "name:agent silent" })');
    expect(dispatchRequest(['exec', 'foot'], 'lua')).toBe('dispatch hl.dsp.exec_cmd("foot")');
  });

  it('refuses a verb it cannot translate instead of silently succeeding', () => {
    // sendclick is a plugin dispatcher; 0.56 has no hl.dsp entry for it.
    expect(() => dispatchRequest(['sendclick', 'address:0x1,button:left'], 'lua')).toThrow(/DISPATCH_UNSUPPORTED|no Lua translation/);
  });

  it('escapes quotes and backslashes so a title cannot break out of the Lua string', () => {
    const req = dispatchRequest(['exec', 'foot --title "a\\b"'], 'lua');
    expect(req).toBe('dispatch hl.dsp.exec_cmd("foot --title \\"a\\\\b\\"")');
  });
});

describe('parseExecRules', () => {
  it('splits the bracket prefix from the command', () => {
    expect(parseExecRules('[workspace name:agent silent] foot -e htop'))
      .toEqual({ rules: { workspace: 'name:agent silent' }, command: 'foot -e htop' });
    expect(parseExecRules('[float; workspace 2] foot'))
      .toEqual({ rules: { float: 'true', workspace: '2' }, command: 'foot' });
    expect(parseExecRules('foot')).toEqual({ rules: {}, command: 'foot' });
  });
});

describe('isDialectError', () => {
  it('recognises the compositor complaining about the request form', () => {
    for (const reply of [
      `[string "return hl.dispatch(exec [workspace name:agent..."]:1: ']' expected near 'name'`,
      'return hl.dispatch("exec foot"):1: hl.dispatch: expected a dispatcher (e.g. hl.dsp.window.close())',
      `[string "return hl.dispatch(hl.dsp.exec("foot"))"]:1: attempt to call a nil value (field 'exec')`,
    ]) {
      expect(isDialectError(reply)).toBe(true);
    }
  });

  it('leaves a genuine refusal alone, so it is reported rather than retried', () => {
    for (const reply of ['Window not found', 'Invalid workspace', 'no such dispatcher']) {
      expect(isDialectError(reply)).toBe(false);
    }
  });
});
