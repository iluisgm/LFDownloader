// Many video hosts refuse requests without the page's Referer/Origin. Extension
// fetches and downloads don't send them, so a short-lived declarativeNetRequest
// session rule adds them for the media host while we work.
import { api } from '../shared/api.js';

const EXT_HOST = new URL(api.runtime.getURL('/')).host;
const ALL_TYPES = ['xmlhttprequest', 'media', 'other', 'object', 'main_frame', 'sub_frame'];
let nextId = 0;

async function allocId() {
  if (!nextId) {
    const { lfdRuleId = 1000 } = await api.storage.session.get('lfdRuleId');
    nextId = lfdRuleId;
  }
  nextId += 2;
  await api.storage.session.set({ lfdRuleId: nextId });
  return nextId;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Install Referer/Origin rules for the hosts of `urls` (optionally also for
 * requests made from the given tabs).
 * Returns the rule ids so they can be removed later.
 */
export async function addHeaderRules(urls, referer, tabIds = []) {
  if (!referer || !api.declarativeNetRequest?.updateSessionRules) return [];
  let origin;
  try {
    origin = new URL(referer).origin;
  } catch {
    return [];
  }
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  if (!hosts.length) return [];
  const id = await allocId();
  const action = {
    type: 'modifyHeaders',
    requestHeaders: [
      { header: 'Referer', operation: 'set', value: referer },
      { header: 'Origin', operation: 'set', value: origin },
    ],
  };
  const rules = [
    // Requests made by our own pages / service worker.
    { id, priority: 1, action, condition: { requestDomains: hosts, initiatorDomains: [EXT_HOST], resourceTypes: ALL_TYPES } },
    // Browser-managed downloads and background requests (tabId -1), plus the
    // manager window's tab — Firefox doesn't match moz-extension initiators.
    { id: id + 1, priority: 1, action, condition: { requestDomains: hosts, tabIds: [-1, ...tabIds], resourceTypes: ALL_TYPES } },
  ];
  try {
    await api.declarativeNetRequest.updateSessionRules({ addRules: rules });
    return rules.map((r) => r.id);
  } catch (e) {
    console.warn('[LFD] header rule failed', e);
    return [];
  }
}

export async function removeHeaderRules(ids) {
  if (!ids?.length) return;
  try {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch { /* already gone */ }
}

/** Run `fn` with Referer rules in place for `url`. */
export async function withHeaders({ url, urls, referer }, fn) {
  const ids = await addHeaderRules(urls || [url], referer);
  try {
    return await fn();
  } finally {
    removeHeaderRules(ids);
  }
}
