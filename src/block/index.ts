import type { RequestInfo } from "@/features";
import type { RuleChange } from "@/offscreen/worker";
import { now, since } from "@/perf";

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

/**
 * Whether a request can get a block rule. Not main_frame: that blocks the page itself. Not without a site
 * (file:, about:). Not a URL with *, ^ or |, which urlFilter can't match literally.
 */
export function blockable(req: RequestInfo): boolean {
  return (
    req.type !== "main_frame" &&
    new URL(req.topLevelUrl).hostname !== "" &&
    !/[*^|]/.test(req.url)
  );
}

function rule(id: number, req: RequestInfo): Rule {
  return {
    id,
    priority: 1,
    action: { type: chrome.declarativeNetRequest.RuleActionType.BLOCK },
    condition: {
      urlFilter: `|${req.url}|`,
      isUrlFilterCaseSensitive: true,
      resourceTypes: [req.type as chrome.declarativeNetRequest.ResourceType],
      // the frame making the request, which differs from the top-level site inside iframes
      initiatorDomains: [new URL(req.topLevelUrl).hostname],
    },
  };
}

/** Installed rules by key, for the worker to continue from. Inverse of `rule`. */
export async function installedRules(): Promise<{ key: string; id: number }[]> {
  return (await chrome.declarativeNetRequest.getDynamicRules()).flatMap(
    ({ id, condition: { urlFilter, initiatorDomains, resourceTypes } }) =>
      urlFilter && initiatorDomains?.length && resourceTypes?.length
        ? [
            {
              id,
              key: key(
                urlFilter.slice(1, -1),
                initiatorDomains[0],
                resourceTypes[0],
              ),
            },
          ]
        : [],
  );
}

/** Rule changes not sent yet, by id: the rule to add, or null to only remove. The latest change of an id wins. */
const pending = new Map<number, Rule | null>();
/** Queue + observe time (epoch ms) of pending adds, for perf. */
const queuedAt = new Map<number, { queued: number; observed: number }>();
let scheduled = false;
let updating = Promise.resolve();

/**
 * Queues a rule change. Changes are sent together once the current task ends, one update at a time.
 * `observedAt`: `Observation.timeStamp`, for time to rule.
 */
export function applyRule(
  change: RuleChange,
  req: RequestInfo,
  observedAt: number,
): void {
  pending.set(change.id, change.action === "add" ? rule(change.id, req) : null);
  if (change.action === "add")
    queuedAt.set(change.id, { queued: now(), observed: observedAt });
  else queuedAt.delete(change.id);

  if (scheduled) return;
  scheduled = true;

  // We push the flush to the back of the js task queue
  // so that all rule changes that come before it can be processed
  setTimeout(() => {
    scheduled = false;
    const batch = [...pending];
    const times = [...queuedAt.values()];
    pending.clear();
    queuedAt.clear();
    updating = updating
      .then(() =>
        chrome.declarativeNetRequest.updateDynamicRules({
          // removing first lets an add replace a rule with the same id; unknown ids are ignored
          removeRuleIds: batch.map(([id]) => id),
          addRules: batch.flatMap(([, r]) => (r ? [r] : [])),
        }),
      )
      .then(() => {
        for (const { queued, observed } of times) {
          since("sw.ruleFlush", queued);
          // until here, repeats still load
          since("sw.timeToRule", observed);
        }
      })
      .catch(console.error);
  });
}
