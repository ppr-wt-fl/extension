import { classify } from "@/model";
import wasmUrl from "../../features/pkg/adflush_features_bg.wasm?url";
import { extract, initRust, presets, type RequestInfo } from "../features";
import { type Observation } from "@/background";
import { flags } from "@/flags";

/**
 * How a request was observed:
 * - webRequest: only the URL, for types whose features don't read the body
 * - refetch: the background downloaded the URL again, GET only, the response can differ from the page's
 * - patch: the page's fetch/XHR, read in the page's JS world (src/content/patch.ts)
 * - dom: the frame's `outerHTML` on load, the parsed and script-modified document instead of the response
 * - debugger: the exact response the page got, through the Chrome DevTools Protocol (behind `flags.debugger`)
 */
export type Source =
  | "webRequest"
  | "refetch"
  | "captured_by_patch"
  | "dom"
  | "debugger";

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
 * Latest verdict of each source, by request (url, topLevelUrl, type).
 * Grows until the service worker stops, which also forgets it.
 */
const verdicts = new Map<string, Map<Source, boolean>>();

/** Whether to block a request, from its sources' verdicts, as set by `flags.reconcile`. */
function decide(bySource: Map<Source, boolean>): boolean {
  if (flags.reconcile === "any") return [...bySource.values()].some(Boolean);
  const best = [...bySource.keys()].reduce((a, b) =>
    BODY_RANK[b] > BODY_RANK[a] ? b : a,
  );
  return bySource.get(best)!;
}

/** One observation of a request. Several sources can observe the same request, with different bodies. */
/** Request types whose features read the body. */
export const BODY_TYPES = new Set(["script", "sub_frame", "main_frame"]);

const FEATURES = presets.adflush;
const rust = initRust(wasmUrl);

/** Runs inference on an observation as soon as it arrives. */
export async function observe(obs: Observation): Promise<void> {
  if (obs.req.type === "xmlhttprequest") {
    // TODO: the features ignore xhr bodies, even for JS the page evals. Classify them as "script", or only keep them as data?
  }
  if (BODY_TYPES.has(obs.req.type) && obs.req.body === undefined) {
    // TODO: no body (non-GET, failed refetch, binary response). Infer with zeroed JS features, skip, or use a URL-only model?
  }
  await rust;
  const features = extract(FEATURES, obs.req);
  // TODO: skip classifying a body identical to one already classified for this request (hash it)
  const key = JSON.stringify([obs.req.url, obs.req.topLevelUrl, obs.req.type]);
  const bySource = verdicts.get(key) ?? new Map<Source, boolean>();
  verdicts.set(key, bySource.set(obs.source, await classify(features)));
  if (decide(bySource)) {
    // TODO: add a declarativeNetRequest rule
  } else {
    // TODO: with "canonical", a better source can overturn a block: remove the rule
  }
  // TODO: keep obs and features as FL training data
}

/** The URL of the page in a tab. A request that completes right after a navigation gets the new page's URL. */
export async function topLevelUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await chrome.tabs.get(tabId)).url;
  } catch {
    // tab closed, or a prerendering tab
    return undefined;
  }
}
