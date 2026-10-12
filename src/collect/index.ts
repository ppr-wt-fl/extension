import { label } from "@/label";
import type { LearnerReply, LearnerRequest } from "@/offscreen/worker";
// FIXME: copy the model into this repo instead of importing it from the robustness-evaluation run
import featureOrder from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/feature_order.json";
import wasmUrl from "../../features/pkg/adflush_features_bg.wasm?url";
import { extract, initRust, type RequestInfo } from "../features";
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
  "webRequest" | "refetch" | "captured_by_patch" | "dom" | "debugger";

/** One observation of a request. Several sources can observe the same request, with different bodies. */
export interface Observation {
  source: Source;
  req: RequestInfo;
  tabId: number;
  /** Unknown for the debugger */
  frameId?: number;
  /** Unknown for the DOM */
  method?: string;
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

const rust = initRust(wasmUrl);

// NOTE: maybe calling chrome.runtime.getContexts every time might be a bit too much
let creatingOffscreen: Promise<void> | undefined;
async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;

  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "src/offscreen/index.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Runs the ad blocking model and its training in a worker",
    })
    .finally(() => (creatingOffscreen = undefined));
  await creatingOffscreen;
}

/** Classifies an observation with the next batch, which also trains on it if it has a label (src/learn). */
export async function observe(obs: Observation): Promise<void> {
  if (obs.req.type === "xmlhttprequest") {
    // TODO: the features ignore xhr bodies, even for JS the page evals. Classify them as "script", or only keep them as data?
  }
  if (BODY_TYPES.has(obs.req.type) && obs.req.body === undefined) {
    // TODO: no body (non-GET, failed refetch, binary response). Infer with zeroed JS features, skip, or use a URL-only model?
  }

  await Promise.all([rust, ensureOffscreenDocument()]);

  const features = extract(FEATURES, obs.req);

  // TODO: skip classifying a body identical to one already classified for this request (hash it)
  const request: LearnerRequest = {
    target: "offscreen",
    request: JSON.stringify([obs.req.url, obs.req.topLevelUrl, obs.req.type]),
    source: obs.source,
    features: [...features],
    site: new URL(obs.req.topLevelUrl).hostname,
    label: await trainingLabel(obs),
  };
  const reply: LearnerReply = await chrome.runtime.sendMessage(request);
  if ("error" in reply) throw new Error(reply.error);
  if (reply.block) {
    // TODO: add a declarativeNetRequest rule
  } else {
    // TODO: with "canonical", a better source can overturn a block: remove the rule
  }
}

/** The label the learner trains an observation on, undefined if it must not: no label, or a forgeable source. */
async function trainingLabel(obs: Observation): Promise<0 | 1 | undefined> {
  if (!flags.learn.sources.includes(obs.source)) return undefined;
  return label(obs.req);
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
