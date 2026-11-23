// Cross-browser WebExtension namespace. Chrome MV3's `chrome.*` and Firefox's
// `browser.*` are both promise-based, so one handle covers both.
export const api = globalThis.browser ?? globalThis.chrome;

export const IS_FIREFOX = /\bFirefox\//.test(navigator.userAgent);

export const EXT_ORIGIN = new URL(api.runtime.getURL('/')).origin;

/** Send a message to the background and unwrap `{ ok, data, error }` replies. */
export async function call(type, payload = {}) {
  const res = await api.runtime.sendMessage({ type, ...payload });
  if (res && res.error) throw new Error(res.error);
  return res?.data;
}
