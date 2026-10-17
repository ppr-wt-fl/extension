import { isAllowRule } from "@/lib/block";
import { outboxStats } from "@/lib/perf/outbox";
import { MAX_RULES } from "@/offscreen/rules";
import { formatSize } from "./export";

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** The tab's hostname, for http(s) pages only: other schemes have no hostname or can't be blocked on anyway. */
export function hostOf(tab: chrome.tabs.Tab): string | undefined {
  if (!tab.url || !/^https?:/.test(tab.url)) return undefined;
  return new URL(tab.url).hostname;
}

// getMatchedRules allows 20 calls per 10 minutes outside a user gesture, so opening the popup often runs out
const COUNT_FRESH_MS = 30_000;

/**
 * Blocked requests on the tab since its last page load, undefined when Chrome won't tell. Reuses the count of the same
 * tab and URL from the last `COUNT_FRESH_MS` unless `fresh`, and any older one when Chrome refuses.
 */
export async function loadBlocked(
  tab: chrome.tabs.Tab,
  fresh = false,
): Promise<number | undefined> {
  if (tab.id === undefined) return undefined;
  const key = `blocked:${tab.id}`;
  const stored = (await chrome.storage.session.get(key))[key] as
    { url?: string; at: number; count: number } | undefined;
  let cached: typeof stored;
  if (stored?.url === tab.url) cached = stored;
  if (!fresh && cached && Date.now() - cached.at < COUNT_FRESH_MS)
    return cached.count;
  // Chrome keeps the matches of the tab's current document, so navigation, bfcache and prerender are handled
  // rejects when rate limited or activeTab isn't granted (some chrome:// pages)
  const matched = await chrome.declarativeNetRequest
    .getMatchedRules({ tabId: tab.id })
    .catch(() => undefined);
  if (!matched) return cached?.count;
  // the allow rules of paused sites match every request there, they block nothing
  const count = matched.rulesMatchedInfo.filter(
    (m) => !isAllowRule(m.rule.ruleId),
  ).length;
  await chrome.storage.session.set({
    [key]: { url: tab.url, at: Date.now(), count },
  });
  return count;
}

/** Sample count and size of the outbox. */
export async function loadOutbox() {
  const stats = await outboxStats();
  let size: string | undefined;
  if (stats.bytes !== undefined) size = formatSize(stats.bytes);
  return { records: stats.records, size };
}

/** Installed block rules and the cap on them, without the allow rules of paused sites. */
export async function loadRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return {
    installed: rules.filter((r) => !isAllowRule(r.id)).length,
    cap: MAX_RULES,
  };
}

/** Removes every block rule and cached verdict, in the service worker (src/background). */
export async function resetRules() {
  await chrome.runtime.sendMessage({ resetRules: true });
}
