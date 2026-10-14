import type { Source } from "@/collect";
import { flags } from "@/flags";
import { logger } from "@/log";

const log = logger("rules");

// The worker's decisions: which requests to block, and the block rules that need. Apart from worker.ts for tests.

/** A block rule the service worker adds or removes. `evict`: a rule to remove along with an add, to stay in the limit. */
export interface RuleChange {
  action: "add" | "remove";
  id: number;
  evict?: number;
}

/** chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES, which the worker can't read. */
export const MAX_RULES = 30_000;

/**
 * How close each source's body is to what the page got, higher is closer. The debugger and the patch see the page's
 * response itself, but the page can spoof patch messages. A refetch is a second response, the DOM isn't a response.
 */
const BODY_RANK: Record<Source, number> = {
  debugger: 4,
  captured_by_patch: 3,
  refetch: 2,
  dom: 1,
  webRequest: 0,
};

/**
 * Id of the block rule of each request key that has one, oldest first. The decision only changes the rules when it
 * changes, as every source of a request sends its own verdict.
 */
export const rules = new Map<string, number>();
let nextRuleId = 1;

/**
 * Continues from the installed rules. Replaces the map: changes of a dead service worker may not have been installed.
 * Ids never go backwards, so a repeated restore can't reuse an installed id.
 */
export function restoreRules(installed: { key: string; id: number }[]): void {
  rules.clear();
  for (const rule of installed) {
    rules.set(rule.key, rule.id);
    nextRuleId = Math.max(nextRuleId, rule.id + 1);
  }
}

/** The rule change a request's decision needs, if any. Past `MAX_RULES`, an add evicts the oldest rule. */
export function ruleChange(key: string, block: boolean): RuleChange | undefined {
  const id = rules.get(key);
  if (block && id === undefined) {
    let evict: number | undefined;
    if (rules.size >= MAX_RULES) {
      const [oldest, oldestId] = rules.entries().next().value!;
      rules.delete(oldest);
      log.debug("rule limit reached, evicting", oldest);
      evict = oldestId;
    }
    const id = nextRuleId++;
    rules.set(key, id);
    return { action: "add", id, evict };
  }
  if (!block && id !== undefined) {
    rules.delete(key);
    return { action: "remove", id };
  }
}

/** Whether to block a request, from its sources' verdicts, as set by `flags.reconcile`. */
export function decide(bySource: Map<Source, boolean>): boolean {
  if (flags.reconcile === "any") return [...bySource.values()].some(Boolean);
  const best = [...bySource.keys()].reduce((a, b) =>
    BODY_RANK[b] > BODY_RANK[a] ? b : a,
  );
  return bySource.get(best)!;
}
