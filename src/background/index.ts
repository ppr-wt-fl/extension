import {
  BODY_TYPES,
  observe,
  restoreAgain,
  topLevelUrl,
  type Observation,
} from "@/lib/collect";
import { flags } from "@/lib/flags";
import { count, gauge, now, initSink, since } from "@/lib/perf";
import { writeMeta } from "@/lib/perf/outbox";
import { featuresWasmBytes } from "@/lib/features";
import {
  disabledSites,
  isAllowRule,
  removeAllRules,
  ruleKey,
  siteDisabled,
} from "@/lib/block";
import { logger } from "@/lib/log";
import * as checked from "./checked";
import { refetch } from "./refetch";

const log = logger("sw");

initSink("sw");
count("sw.starts");
log.debug("service worker started");
// wasm linear memory of the feature extractor, only grows. performance.memory is Window-only, so no heap here
// (measureUserAgentSpecificMemory needs cross-origin isolation, which the extension isn't)
if (flags.perf.enabled) {
  setInterval(() => {
    const bytes = featuresWasmBytes();
    if (bytes !== undefined) gauge("features.wasmBytes", bytes);
  }, flags.perf.flushMs);
}
// profile start (browser launch), not SW wake-ups
chrome.runtime.onStartup.addListener(() => count("browser.starts"));
// Environment, on browser launch, install and extension or Chrome update. The offscreen worker writes its own (tfjs backend, model)
if (flags.perf.enabled) {
  const writeSwMeta = () =>
    swMeta()
      .then((meta) => writeMeta("sw", meta))
      .catch(log.error);
  chrome.runtime.onStartup.addListener(writeSwMeta);
  chrome.runtime.onInstalled.addListener(writeSwMeta);
}

async function swMeta() {
  // not in TS's DOM lib: Chromium only
  const nav = navigator as Navigator & {
    userAgentData?: {
      getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
    };
    deviceMemory?: number;
  };
  return {
    version: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    userAgentData: await nav.userAgentData?.getHighEntropyValues([
      "platform",
      "platformVersion",
      "architecture",
      "model",
      "fullVersionList",
    ]),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
  };
}

// the testers' notice, once
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install")
    chrome.tabs.create({
      url: chrome.runtime.getURL("src/onboarding/index.html"),
    });
});

// The sites the user turned the extension off on, read on every service worker start and again when the popup
// changes them, so requests don't each read the allow rule
let disabled: Promise<string[]> = Promise.resolve([]);
if (!flags.processDisabledSites) {
  disabled = disabledSites().catch(() => []);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.disabledSitesChanged === true)
      disabled = disabledSites().catch(() => []);
  });
}

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
    // the allow rules (src/lib/block) override any rule we'd add, so no refetch, verdict or rule: they cover the
    // disabled site's pages and what the site starts in iframes on other sites, but not its navigations
    if (!flags.processDisabledSites) {
      const sites = await disabled;
      let initiator = "";
      if (details.type !== "main_frame")
        initiator = URL.parse(details.initiator ?? "")?.hostname ?? "";
      if (
        siteDisabled(sites, new URL(top).hostname) ||
        siteDisabled(sites, initiator)
      )
        return;
    }

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
      const body = hasBody
        ? await refetch(details.url, details.initiator)
        : undefined;
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
      const bodyBytes = hasBody
        ? await refetch(details.url, details.initiator)
        : undefined;

      // a failed refetch gives 0, which never matches a stored body
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
      } else if (!hasBody || bodyBytes) {
        // A body verdict made without its body is URL-only: don't cache it, or its validator would skip the next refetch
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
    count("sw.listenerFailed");
  }
}

// The popup's reset: no block rules, no cached verdicts. The worker then restores from the installed rules, else it
// keeps the removed ones and never adds them again.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.resetRules !== true) return;
  (async () => {
    await Promise.all([removeAllRules(), checked.clear()]);
    await restoreAgain();
    log.info("reset rules and verdict cache");
  })()
    .catch(log.error)
    .finally(() => sendResponse());

  return true;
});

// Rule hits, unpacked only. Block rules block, so a hit is a blocked request; the allow rules of disabled sites also
// match, those aren't hits. Tab requests only, like sw.requestsCompleted (blocked ones never complete).
if (flags.perf.enabled) {
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener(
    ({ request, rule }) => {
      // NOTE: should we really make sure it comes from a user tab? blocking other stuff is valid usage I would guess
      if (isAllowRule(rule.ruleId)) return;
      if (request.tabId >= 0) count("block.hits");
    },
  );
}
