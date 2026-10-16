import { outboxStats } from "@/lib/perf/outbox";
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

/** Blocked requests on the tab since its last page load, undefined when Chrome won't tell. */
export async function loadBlocked(tab: chrome.tabs.Tab): Promise<number | undefined> {
  if (tab.id === undefined) return undefined;
  // Chrome keeps the matches of the tab's current document, so navigation, bfcache and prerender are handled
  // rejects when rate limited or activeTab isn't granted (some chrome:// pages)
  const matched = await chrome.declarativeNetRequest
    .getMatchedRules({ tabId: tab.id })
    .catch(() => undefined);
  return matched?.rulesMatchedInfo.length;
}

/** Sample count and size of the outbox. */
export async function loadOutbox() {
  const stats = await outboxStats();
  let size: string | undefined;
  if (stats.bytes !== undefined) size = formatSize(stats.bytes);
  return { records: stats.records, size };
}

/** Installed block rules and Chrome's cap on them. */
export async function loadRules() {
  return {
    installed: (await chrome.declarativeNetRequest.getDynamicRules()).length,
    cap: chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES,
  };
}

/** Removes every block rule and cached verdict, in the service worker (src/background). */
export async function resetRules() {
  await chrome.runtime.sendMessage({ resetRules: true });
}
