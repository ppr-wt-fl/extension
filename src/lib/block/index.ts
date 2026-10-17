import type { RequestInfo } from "@/lib/features";
import { MAX_RULES, type RuleChange } from "@/offscreen/rules";
import { flags } from "@/lib/flags";
import { logger } from "@/lib/log";
import { count, now, since } from "@/lib/perf";

const log = logger("block");

// Applies the block rules the offscreen worker decides on (src/offscreen/worker.ts), as dynamic rules: they survive
// browser restarts, the worker's verdicts don't, so the worker gets the installed rules back with `installedRules`.
// Service worker only: the offscreen document has no chrome.declarativeNetRequest.

type Rule = chrome.declarativeNetRequest.Rule;

// TODO: more efficient handling of these rule keys and such

function key(url: string, site: string, type: string): string {
  return JSON.stringify([url, site, type]);
}

/**
 * Identifies what a block rule matches: the URL, the top-level site and the type. The worker keeps verdicts by this
 * key, and each key gets at most one rule.
 */
export function ruleKey(req: RequestInfo): string {
  return key(req.url, new URL(req.topLevelUrl).hostname, req.type);
}

/** Whether a URL is one of our own extension's files, e.g. the content script's chunks the page loads. */
export function isOwnUrl(url: string): boolean {
  return url.startsWith(chrome.runtime.getURL(""));
}

/**
 * Whether a request can get a block rule. Not main_frame: that blocks the page itself. Not our own files: no ad, and
 * DNR never matches chrome-extension: URLs anyway. Not without a site (file:, about:). Not a URL with *, ^ or |, which
 * urlFilter can't match literally, or with non-ASCII or whitespace, which makes the rule invalid and so its whole batch
 * fail.
 */
export function blockable(req: RequestInfo): boolean {
  return (
    req.type !== "main_frame" &&
    !isOwnUrl(req.url) &&
    new URL(req.topLevelUrl).hostname !== "" &&
    literalUrlFilter(req.url)
  );
}

/** Whether `|url|` as a urlFilter matches exactly that URL, see `blockable`. */
export function literalUrlFilter(url: string): boolean {
  return /^[\x21-\x7e]+$/.test(url) && !/[*^|]/.test(url);
}

/**
 * Session rule that sets the Referer on our own refetch of `url` (src/background), which fetch can't set cross-origin.
 * Servers, ad servers especially, can answer differently without the Referer the page sent.
 */
export function refererRule(id: number, url: string, referer: string): Rule {
  return {
    id,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        {
          header: "referer",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: referer,
        },
      ],
    },
    condition: {
      urlFilter: `|${url}|`,
      isUrlFilterCaseSensitive: true,
      // requests of the extension itself: no tab, initiated by our origin
      tabIds: [-1],
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
    },
  };
}

// shortcut: exact-URL rules never match again for URLs with cache busters (?cb=, correlator=), so those ads load once
// per page load and their rules only fill MAX_RULES. Matching without the query would block every call to endpoints
// whose meaning is in the query (/graphql?op=, load.php?modules=), and merge their verdicts and cache entries
// (src/background/checked.ts). Upgrade when block.hits vs rules.added shows it matters: wildcard known
// cache-buster params' values with * in urlFilter and ruleKey.
export function rule(id: number, req: RequestInfo): Rule {
  return {
    id,
    priority: 1,
    action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
    condition: {
      urlFilter: `|${req.url}|`,
      isUrlFilterCaseSensitive: true,
      resourceTypes: [req.type as chrome.declarativeNetRequest.ResourceType],
      // not initiatorDomains: that is the frame making the request, e.g. an ad iframe's own site
      topDomains: [new URL(req.topLevelUrl).hostname],
    },
  };
}

/**
 * Installed rules by key, for the worker to continue from. Inverse of `rule`. Removes rules of our own files, which
 * older versions installed: they never match and only take up rule slots. Also removes the oldest block rules past
 * `MAX_RULES`, which older versions with fewer allow rules filled up to.
 */
export async function installedRules(): Promise<{ key: string; id: number }[]> {
  // a resync after a failed update must not read rules an update queued before it is about to change
  await flush?.catch(() => {});
  await updating;
  const all = await chrome.declarativeNetRequest.getDynamicRules();
  const own = all.filter((r) =>
    isOwnUrl(r.condition.urlFilter?.slice(1) ?? ""),
  );
  const blocks = all
    .filter((r) => r.condition.urlFilter && !own.includes(r))
    .sort((a, b) => a.id - b.id);
  const bad = [
    ...own,
    ...blocks.slice(0, Math.max(0, blocks.length - MAX_RULES)),
  ];
  if (bad.length) {
    log.info("removing rules of own files or past the limit:", bad.length);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: bad.map((r) => r.id),
    });
  }
  return all
    .filter((r) => !bad.includes(r))
    .flatMap(({ id, condition: { urlFilter, topDomains, resourceTypes } }) =>
      urlFilter && topDomains?.length && resourceTypes?.length
        ? [
            {
              id,
              key: key(urlFilter.slice(1, -1), topDomains[0], resourceTypes[0]),
            },
          ]
        : [],
    );
}

/**
 * Ids of the two rules that turn blocking off on the sites the user picked in the popup. Block rule ids count up from 1
 * (src/offscreen/rules.ts) and never reach these. `installedRules` skips them as they have no urlFilter, so the worker
 * never learns about them.
 */
const ALLOW_RULE_ID = 2 ** 31 - 1;
const ALLOW_WORKERS_RULE_ID = 2 ** 31 - 2;

/** Hostnames blocking is off on. Stored in the allow rule itself, so the rule can't get out of sync with a list. */
export async function disabledSites(): Promise<string[]> {
  const [allow] = await chrome.declarativeNetRequest.getDynamicRules({
    ruleIds: [ALLOW_RULE_ID],
  });
  return allow?.condition.requestDomains ?? [];
}

/** Whether blocking is off on `host`. requestDomains also matches subdomains, so "example.com" covers "www.example.com". */
export function siteDisabled(sites: string[], host: string): boolean {
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/**
 * Turns blocking on `host` off or on, like uBlock Origin Lite's power button. Takes effect on the next page load: DNR
 * checks allowAllRequests when a frame navigates.
 */
export async function setSiteDisabled(
  host: string,
  disabled: boolean,
): Promise<void> {
  // Drop host and subdomains
  const sites = (await disabledSites()).filter(
    (site) => !siteDisabled([site], host),
  );

  // add host back in if needed
  if (disabled) sites.push(host);

  // record
  if (disabled) {
    count("block.siteDisabledByUser");
  } else {
    count("block.siteReenabledByUser");
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ALLOW_RULE_ID, ALLOW_WORKERS_RULE_ID],
    // requestDomains can't be empty: no sites, no rules
    addRules: sites.length
      ? [
          {
            id: ALLOW_RULE_ID,
            // above the block rules' 1. allowAllRequests on the top-level page allows every request of the page and
            // its iframes, so their block rules never apply
            priority: 2,
            action: {
              type: chrome.declarativeNetRequest.RuleActionType
                .ALLOW_ALL_REQUESTS,
            },
            condition: {
              requestDomains: sites,
              resourceTypes: [
                chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
              ],
            },
          },
          {
            id: ALLOW_WORKERS_RULE_ID,
            // the site's service and shared workers belong to no frame, so allowAllRequests misses their requests.
            // Also allows the site's own requests inside iframes on other sites
            priority: 2,
            action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW },
            condition: { initiatorDomains: sites },
          },
        ]
      : [],
  });
  // the service worker keeps the list in memory to skip these sites' requests (src/background)
  if (!flags.processDisabledSites)
    await chrome.runtime
      .sendMessage({ disabledSitesChanged: true })
      .catch(log.error);
}

/** Rule changes not sent yet, by id: the rule to add, or null to only remove. The latest change of an id wins. */
const pending = new Map<number, Rule | null>();
/** Queue + observe time (epoch ms) of pending adds, for perf. */
const queuedAt = new Map<number, { queued: number; observed: number }>();
/** The update the queued changes go into, until it takes them. */
let flush: Promise<void> | undefined;
let updating = Promise.resolve();

/**
 * Queues a rule change. Changes are sent together once the current task ends, one update at a time: changes queued
 * during an update go into the next one, since each update re-indexes every rule.
 * `observedAt`: `Observation.timeStamp`, for time to rule.
 * Resolves once the change's update is done, rejects if it failed: then the worker's rules are out of sync with Chrome's.
 */
export function applyRule(
  change: RuleChange,
  req: RequestInfo,
  observedAt: number,
): Promise<void> {
  pending.set(change.id, change.action === "add" ? rule(change.id, req) : null);
  if (change.evict !== undefined) {
    pending.set(change.evict, null);
    queuedAt.delete(change.evict);
  }
  if (change.action === "add")
    queuedAt.set(change.id, { queued: now(), observed: observedAt });
  else queuedAt.delete(change.id);

  // We push the flush to the back of the js task queue
  // so that all rule changes that come before it can be processed
  flush ??= new Promise((resolve) => setTimeout(resolve)).then(() => {
    const update = updating.then(() => {
      // taken once the previous update is done, so everything queued meanwhile goes in one call
      flush = undefined;
      const batch = [...pending];
      // removeAllRules emptied the queue
      if (!batch.length) return;
      log.debug("rule update", batch);
      const times = [...queuedAt.values()];
      pending.clear();
      queuedAt.clear();
      count("sw.ruleUpdate");
      return chrome.declarativeNetRequest
        .updateDynamicRules({
          // removing first lets an add replace a rule with the same id; unknown ids are ignored
          removeRuleIds: batch.map(([id]) => id),
          addRules: batch.flatMap(([, r]) => (r ? [r] : [])),
        })
        .then(() => {
          for (const { queued, observed } of times) {
            since("sw.ruleFlush", queued);
            // until here, repeats still load
            since("sw.timeToRule", observed);
          }
        });
    });
    updating = update.catch(log.error);
    return update;
  });
  return flush;
}

/** Drops the queued changes and removes every installed block rule, after the update running now. */
export function removeAllRules(): Promise<void> {
  pending.clear();
  queuedAt.clear();
  const done = updating.then(async () => {
    const ids = (await chrome.declarativeNetRequest.getDynamicRules())
      .map((r) => r.id)
      // the user's disabled sites aren't block rules
      .filter((id) => id !== ALLOW_RULE_ID && id !== ALLOW_WORKERS_RULE_ID);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ids,
    });
  });
  updating = done.catch(log.error);
  return done;
}
