import {
  applyRule,
  blockable,
  installedRules,
  isOwnUrl,
  ruleKey,
} from "@/lib/block";
import { label } from "@/lib/label";
import type {
  LearnerReply,
  LearnerRequest,
  RestoreRequest,
} from "@/offscreen/worker";
// FIXME: copy the model into this repo instead of importing it from the robustness-evaluation run
import featureOrder from "../../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/feature_order.json";
import wasmUrl from "../../../features/pkg/adflush_features_bg.wasm?url";
import {
  extract as extractFeatures,
  initRust,
  type RequestInfo,
} from "../features";
import { logger } from "@/lib/log";
import { count, now, record, since } from "@/lib/perf";

const log = logger("collect");

/**
 * How a request was observed, one source per request type. Only sources a page can't forge:
 * - webRequest: only the URL, for types whose features don't read the body
 * - refetch: the background downloaded the URL again, GET only, the response can differ from the page's
 */
export type Source = "webRequest" | "refetch";

/** One observation of a request. */
export interface Observation {
  source: Source;
  req: RequestInfo;
  tabId: number;
  frameId: number;
  method: string;
  /** ms since the epoch */
  timeStamp: number;
}

/** Request types whose features read the body. */
export const BODY_TYPES = new Set(["script", "sub_frame", "main_frame"]);

// the AdFlush export calls keyword_raw_present keyword_char_present
// FIXME: this shouldn't be part of the repo :(
const FEATURES = featureOrder.feature_order.map((name) =>
  name === "keyword_char_present" ? "keyword_raw_present" : name,
);

// in dev wasmUrl is root-relative to the vite server, not the extension origin
const rust = initRust(new URL(wasmUrl, import.meta.url));

let creatingOffscreen: Promise<void> | undefined;
/**
 * Whether this service worker gave the document the installed rules. Else its rule ids restart at 1 and overwrite
 * installed rules: the restore failed, or a previous service worker died between creating the document and restoring.
 */
let restored = false;
/** Creates the offscreen document holding the learner (src/offscreen) unless it exists, and gives it the installed rules. */
async function ensureOffscreenDocument(timeout = 3_000): Promise<void> {
  // set up by this service worker; a failed send resets `restored` in case the document died
  if (restored && !creatingOffscreen) return;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  // a document still being created doesn't have the rules yet
  if (contexts.length > 0 && restored && !creatingOffscreen) return;

  creatingOffscreen ??= (async () => {
    const start = now();
    if (contexts.length === 0) {
      // createDocument can resolve before the document listens (in dev it imports its script after load), so wait for it
      const ready = new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(reject, timeout);

        function onReady(message: any) {
          if (message?.offscreenReady !== true) return;
          clearTimeout(timeoutId);
          chrome.runtime.onMessage.removeListener(onReady);
          resolve();
        }

        chrome.runtime.onMessage.addListener(onReady);
      });

      await chrome.offscreen.createDocument({
        url: "src/offscreen/index.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Runs the ad blocking model and its training in a worker",
      });
      await ready;
    }

    const restore: RestoreRequest = {
      target: "offscreen",
      restore: await installedRules(),
    };
    const reply: LearnerReply = await chrome.runtime.sendMessage(restore);
    if ("error" in reply) throw new Error(reply.error);
    restored = true;
    // model load: startup.* in worker
    if (contexts.length === 0) {
      since("sw.offscreenCreate", start);
      count("offscreen.creations");
    }
    log.info(
      "offscreen document ready, restored rules:",
      restore.restore.length,
    );
  })().finally(() => (creatingOffscreen = undefined));
  await creatingOffscreen;
}

/** Classifies an observation with the next batch, which also trains on it if it has a label (src/lib/learn).
 * Computes features on callers thread. Resolves to whether to block it.
 * */
export async function observe(obs: Observation): Promise<boolean> {
  // our own files (the content script's chunks the page loads): no ads, no training data
  if (isOwnUrl(obs.req.url)) return false;
  count(`sw.observations.${obs.source}`);
  log.trace(obs.source, obs.req.type, obs.req.url, obs.req.body?.length);
  // TODO: the features ignore xhr bodies, even for JS the page evals. Classify them as "script", or only keep them as data?
  if (BODY_TYPES.has(obs.req.type) && obs.req.body === undefined) {
    // TODO: no body (non-GET, failed refetch, binary response). Infer with zeroed JS features, skip, or use a URL-only model?
    count(`sw.bodyMissing.${obs.req.type}`);
  }

  let start = now();
  // NOTE: always awaiting this stuff is going to put us at the back of the task queue, probably could be avoided you know?
  await Promise.all([rust, ensureOffscreenDocument()]);
  since("sw.ready", start);

  start = now();
  const features = extractFeatures(FEATURES, obs.req);
  since(`sw.features.${obs.req.type}`, start);
  if (obs.req.body !== undefined)
    record(`sw.featuresBodyChars.${obs.req.type}`, obs.req.body.length);

  const request: LearnerRequest = {
    target: "offscreen",
    request: ruleKey(obs.req),
    blockable: blockable(obs.req),
    source: obs.source,
    req: { url: obs.req.url, topLevelUrl: obs.req.topLevelUrl, type: obs.req.type },
    features: [...features],
    site: new URL(obs.req.topLevelUrl).hostname,
    label: await label(obs.req),
    sentAt: now(),
  };

  let reply: LearnerReply;
  try {
    reply = await chrome.runtime.sendMessage(request);
  } catch (error) {
    // the document is gone (crashed or closed): the next observation checks for it and recreates it
    restored = false;
    throw error;
  }
  if ("error" in reply) throw new Error(reply.error);
  if (reply.repliedAt !== undefined) since("hop.workerToSw", reply.repliedAt);
  since("sw.timeToVerdict", obs.timeStamp);

  if (reply.rule) {
    applyRule(reply.rule, obs.req, obs.timeStamp);
  }

  return reply.block === true;
}

/** Tab URLs seen by `topLevelUrl`, kept current by tab events, so most requests skip `chrome.tabs.get`. */
const tabUrls = new Map<number, string>();
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) tabUrls.set(tabId, change.url);
});
chrome.tabs.onRemoved.addListener((tabId) => tabUrls.delete(tabId));
chrome.tabs.onReplaced.addListener((_added, removed) =>
  tabUrls.delete(removed),
);

/** The URL of the page in a tab. A request that completes right after a navigation gets the new page's URL. */
export async function topLevelUrl(tabId: number): Promise<string | undefined> {
  const known = tabUrls.get(tabId);
  if (known) return known;
  try {
    const url = (await chrome.tabs.get(tabId)).url;
    if (url) tabUrls.set(tabId, url);
    return url;
  } catch {
    // tab closed, or a prerendering tab
    return undefined;
  }
}
