import { BODY_TYPES, observe, topLevelUrl, type Observation } from "../collect";
import { flags } from "../flags";
import { count, now, record, initSink, since } from "../perf";
import { ruleKey } from "@/block";
import { logger } from "@/log";
import * as checked from "./checked";

const log = logger("sw");

initSink("sw");
count("sw.starts");
log.debug("service worker started");
// profile start (browser launch), not SW wake-ups
chrome.runtime.onStartup.addListener(() => count("browser.starts"));

chrome.webRequest.onCompleted.addListener(
  onCompleted,
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

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

    function classify(bytes?: ArrayBuffer) {
      if (BODY_TYPES.has(details.type)) {
        observation.source = "refetch";
        observation.req = {
          ...observation.req,
          body: bytes && new TextDecoder().decode(bytes),
        };
      }

      return observe(observation);
    }

    // Only GET is safe to repeat. Without a body the features only depend on the URL, like webRequest's
    const hasBody = BODY_TYPES.has(details.type) && details.method === "GET";

    if (!flags.cache.enabled) {
      const body = hasBody ? await refetch(details.url) : undefined;
      return await classify(body);
    }

    await checked.ready();

    const ruleKeyHash = checked.hashRuleKey(ruleKey(observation.req));
    const tier = checked.tier(ruleKeyHash, hasBody);
    count(`cache.${tier}`);

    // This exact same request was already seen and is pending
    if (tier === "inflight") return;

    const entry = checked.get(ruleKeyHash);
    // Recently checked
    if (tier === "fresh") {
      return checked.touch(ruleKeyHash);
    }

    // Mark this request as pending -> if the same one comes again it will be skipped
    checked.pending.add(ruleKeyHash);
    try {
      const t = checked.nowS();
      const headers = hasBody
        ? checked.validator(details.responseHeaders)
        : undefined;
      const validator = headers ? await checked.hash30(headers) : 0;

      // Same validator header as when classified -> the server says it's unchanged -> classification is already done
      if (
        tier === "needs-body-validation" &&
        validator &&
        validator === entry!.validator
      ) {
        count("cache.validatorHit");
        // Update entry + mark as recently used
        return checked.put(ruleKeyHash, { ...entry!, checkedAt: t });
      }

      // Refetch the body, the model needs it anyway. Same hash as when classified: unchanged, skip the model
      const bodyBytes = hasBody ? await refetch(details.url) : undefined;

      // a failed refetch never matches, so the next load refetches again
      const bodyHash = bodyBytes ? await checked.hash30(bodyBytes) : 0;

      if (
        tier === "needs-body-validation" &&
        bodyHash &&
        bodyHash === entry!.body
      ) {
        count("cache.bodyHit");
        // Update entry + mark as recently used
        return checked.put(ruleKeyHash, { ...entry!, checkedAt: t, validator });
      }

      // New, too old or changed -> change
      const block = await classify(bodyBytes);
      if (block) {
        checked.drop(ruleKeyHash);
      } else {
        checked.put(ruleKeyHash, {
          classifiedAt: t,
          checkedAt: t,
          validator,
          body: bodyHash,
        });
      }
    } finally {
      checked.pending.delete(ruleKeyHash);
    }
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
async function refetch(url: string): Promise<ArrayBuffer | undefined> {
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
    return bytes;
  } catch (error) {
    log.debug("refetch failed", error, url);
    count("sw.refetchFailed");
    return undefined;
  }
}
