import { BODY_TYPES, observe, topLevelUrl, type Observation } from "../collect";
import type { RelayMessage } from "../content/relay";
import { flags } from "../flags";
import { count, now, record, since } from "../perf";
import { bumpSessionCounter } from "../perf/session";
import { captureWithDebugger } from "./debugger";

void bumpSessionCounter("sw.starts");

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    since("sw.eventDelay", details.timeStamp);
    // Requests outside tabs have no top-level page.
    // These include the refetches below, and page service workers' requests.
    if (details.tabId < 0) return;

    // block.hits / (block.hits + this) = share of tab requests blocked
    // NOTE: should we really make sure it comes from a user tab? blocking other stuff is valid usage I would guess
    count("sw.requestsCompleted");

    // FIXME: MAYBE THIS CAN BE DONE IN A BETTER WAY
    const start = now();
    const top =
      details.type === "main_frame"
        ? details.url
        : await topLevelUrl(details.tabId);
    if (details.type !== "main_frame") since("sw.topLevelUrl", start);
    if (!top) return;

    const observation: Observation = {
      source: "webRequest",
      req: { url: details.url, topLevelUrl: top, type: details.type },
      tabId: details.tabId,
      frameId: details.frameId,
      method: details.method,
      timeStamp: details.timeStamp,
    };

    if (!BODY_TYPES.has(details.type)) return observe(observation);
    // Only GET is safe to repeat
    const body =
      details.method === "GET" ? await refetch(details.url) : undefined;

    return observe({
      ...observation,
      source: "refetch",
      req: { ...observation.req, body },
    });
  },
  { urls: ["<all_urls>"] },
);

chrome.runtime.onMessage.addListener((message: RelayMessage, sender) => {
  const tabId = sender.tab?.id;
  const top = sender.tab?.url;
  if (tabId === undefined || !top || !sender.url) return;

  //  Flushed performance metrics
  if (message.source === "patch_perf") {
    // content script metrics for patched request functions
    record("page.patchMs", message.ms);
    record("page.patchCaptures", message.captures);
    return;
  }
  if (message.source === "relay_perf") {
    // message realying perf data
    record("page.relayMs", message.ms);
    return;
  }

  if (message.source === "dom" && message.serializeMs !== undefined) {
    record("page.outerHtmlMs", message.serializeMs);
    record("page.outerHtmlChars", message.body.length);
  }

  const isPatch = message.source === "captured_by_patch";
  observe({
    source: message.source,
    req: {
      // webRequest URLs have no fragment
      url: isPatch ? message.url : sender.url.split("#")[0],
      topLevelUrl: top,
      // Chrome's webRequest type for both fetch and XHR
      type: isPatch
        ? "xmlhttprequest"
        : sender.frameId === 0
          ? "main_frame"
          : "sub_frame",
      body: message.body,
    },
    tabId,
    frameId: sender.frameId,
    method: isPatch ? message.method : undefined,
    timeStamp: Date.now(),
  }).catch(console.error);
});

if (flags.debugger) captureWithDebugger();

// Rule hits, unpacked only. All rules block, so a hit is a blocked request; tab requests only, like
// sw.requestsCompleted (blocked ones never complete).
if (flags.perf.enabled) {
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(
    ({ request }) => {
      // NOTE: should we really make sure it comes from a user tab? blocking other stuff is valid usage I would guess
      if (request.tabId >= 0) count("block.hits");
    },
  );
}

/**
 * Downloads a URL again, for the body webRequest doesn't expose. It can differ from what the page got: this request
 * has another cache partition, Referer and, depending on SameSite, cookies.
 */
async function refetch(url: string): Promise<string | undefined> {
  const start = now();
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      count("sw.refetchFailed");
      return undefined;
    }
    // decompressed: upper bound of extra traffic
    const bytes = await response.arrayBuffer();
    record("sw.refetchBytes", bytes.byteLength);
    since("sw.refetch", start);
    return new TextDecoder().decode(bytes);
  } catch {
    count("sw.refetchFailed");
    return undefined;
  }
}
