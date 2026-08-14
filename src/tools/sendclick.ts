/**
 * sendclick plugin probe — is hyprland-mcp-click loaded?
 *
 * When it is, the server collapses an overlay click into one atomic
 * `sendclick` dispatch instead of 4 roundtrips + a sleep + ydotool. Cached per
 * ipc instance for the lifetime of the process (plugins rarely hot-load
 * mid-session).
 */
const sendclickCache = new WeakMap<object, boolean>();

export async function probeSendclick(ipc: { request: (req: string) => Promise<string> }): Promise<boolean> {
  const cached = sendclickCache.get(ipc);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    const list = await ipc.request('plugin list');
    available = list.includes('hyprland-mcp-click');
  } catch {
    available = false;
  }
  sendclickCache.set(ipc, available);
  return available;
}
