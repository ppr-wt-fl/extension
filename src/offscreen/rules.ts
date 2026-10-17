import { logger } from "@/lib/log";
import { count } from "@/lib/perf";

const log = logger("rules");

// The worker's decisions: which requests to block, and the block rules that need. Apart from worker.ts for tests.

/** A block rule the service worker adds or removes. */
export interface RuleChange {
  action: "add" | "remove";
  id: number;
}

/**
 * chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES, which the worker can't read, minus the slots of the
 * two allow rules for sites with blocking turned off (ALLOW_RULE_ID in src/lib/block).
 */
export const MAX_RULES = 30_000 - 2;

/**
 * Id of the block rule of each request key that has one. The decision only changes the rules when it
 * changes, as a request is classified again on every load.
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

/** The rule change a request's decision needs, if any. At `MAX_RULES`, no more rules are added. */
export function ruleChange(
  key: string,
  block: boolean,
): RuleChange | undefined {
  const id = rules.get(key);
  if (block && id === undefined) {
    // FIXME: at the limit the request just isn't blocked. Far off in practice (watch rules.full); if it's hit,
    // evict instead: the least recently blocking rule, reported by the service worker from
    // webRequest.onErrorOccurred (ERR_BLOCKED_BY_CLIENT), else simply the oldest.
    if (rules.size >= MAX_RULES) {
      log.debug("rule limit reached, not blocking", key);
      count("rules.full");
      return;
    }
    const id = nextRuleId++;
    rules.set(key, id);
    return { action: "add", id };
  }
  if (!block && id !== undefined) {
    rules.delete(key);
    return { action: "remove", id };
  }
}
