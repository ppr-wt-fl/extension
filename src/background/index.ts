import { BODY_TYPES, observe, topLevelUrl, type Observation } from "../collect";
import { flags } from "../flags";
import { count, now, record, initSink, since } from "../perf";
import { logger } from "@/log";

const log = logger("sw");

initSink("sw");
count("sw.starts");
log.debug("service worker started");
// profile start (browser launch), not SW wake-ups
chrome.runtime.onStartup.addListener(() => count("browser.starts"));

chrome.webRequest.onCompleted.addListener(onCompleted, {
  urls: ["<all_urls>"],
});

async function onCompleted(details: chrome.webRequest.OnCompletedDetails) {
  try {
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
  } catch (error) {
    log.error("chrome.webRequest.onCompleted listener failed");
    log.error(error);
  }
}

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
      log.debug("refetch failed", response.status, url);
      count("sw.refetchFailed");
      return undefined;
    }
    // decompressed: upper bound of extra traffic
    const bytes = await response.arrayBuffer();
    record("sw.refetchBytes", bytes.byteLength);
    since("sw.refetch", start);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    log.debug("refetch failed", error, url);
    count("sw.refetchFailed");
    return undefined;
  }
}
