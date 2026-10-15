import { env, io, memory, setBackend } from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import tfWasmUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url";
import tfSimdUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url";
import type { Source } from "@/lib/collect";
import { flags } from "@/lib/flags";
import type { RequestInfo } from "@/lib/features";
import { Learner } from "@/lib/learn";
import { loadLists } from "@/lib/lists";
import { inputSize, loadModel, THRESHOLD } from "@/model";
import { logger } from "@/lib/log";
import { count, gauge, now, initSink, since } from "@/lib/perf";
import { restoreRules, type RuleChange, ruleChange, rules } from "./rules";
// FIXME: copy the model into this repo instead of importing it from the robustness-evaluation run
import modelJson from "../../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/model.json";
import featureOrder from "../../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/feature_order.json";
import weightsUrl from "../../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/group1-shard1of1.bin?url";

// Holds the state that should outlive the service worker, which Chrome stops when idle: the learner and the
// block rules' ids. Lost when the browser or the extension restarts, except the rules (src/lib/block).

/** One observation of a request, from the service worker. */
export interface LearnerRequest {
  target: "offscreen";
  /** Identifies the request, `ruleKey` in src/lib/block */
  request: string;
  /** Whether the request can get a block rule, `blockable` in src/lib/block */
  blockable: boolean;
  source: Source;
  /** For the filter lists' verdict (src/lib/lists) */
  req: Omit<RequestInfo, "body" | "acornAsts">;
  features: number[];
  /** Top-level site of the request */
  site: string;
  /** Training label, undefined to only classify */
  label?: 0 | 1;
  /** SW send time, `now()` */
  sentAt?: number;
}

/** The dynamic rules installed before this worker started, so it continues from them. */
export interface RestoreRequest {
  target: "offscreen";
  restore: { key: string; id: number }[];
}

export type OffscreenRequest = LearnerRequest | RestoreRequest;

// TODO: feels like this type shouldn't live here
/** `block`: the request's verdict. `rule` is set when its decision changed. `repliedAt`: `now()`, for hop.* */
export type LearnerReply =
  | { block?: boolean; rule?: RuleChange; repliedAt?: number }
  // `closing`: the worker died and the offscreen document is closing, the next request needs a new one
  | { error: string; closing?: true };

initSink("worker");
const log = logger("worker");

let learner: Learner | undefined;

// Gauges: current sizes, as a sample when they change
if (flags.perf.enabled) {
  setInterval(() => {
    // an uncaught error here reaches the document's worker.onerror, which closes it
    try {
      const tf = memory();
      gauge("rules", rules.size);
      // growing = leak
      gauge("tf.numTensors", tf.numTensors);
      gauge("tf.numBytes", tf.numBytes);
      for (const [k, v] of Object.entries(learner?.sizes() ?? {}))
        gauge(`learner.${k}`, v);
    } catch (error) {
      log.error("gauges failed", error);
    }
  }, flags.perf.flushMs);
}

// failing lists only lose the comparison, not the verdicts
const checkLists =
  flags.lists && flags.perf.enabled
    ? loadLists().catch(
        (error) => void log.error("filter lists failed to load", error),
      )
    : undefined;

const learnerPromise = (async () => {
  const startupStart = now();
  let start = now();
  // no threads: they need cross-origin isolation
  env().set("WASM_HAS_MULTITHREAD_SUPPORT", false);
  // TODO: how generalizable is this?
  setWasmPaths({
    "tfjs-backend-wasm.wasm": tfWasmUrl,
    "tfjs-backend-wasm-simd.wasm": tfSimdUrl,
    // never loaded, but setWasmPaths wants every binary
    "tfjs-backend-wasm-threaded-simd.wasm": tfSimdUrl,
  });
  // TODO: maybe pick the best backend possible
  await setBackend("wasm");
  since("startup.backend", start);

  start = now();
  const json = modelJson as unknown as io.ModelJSON;
  const weights = await (await fetch(weightsUrl)).arrayBuffer();
  const [global, local] = await Promise.all([
    loadModel(json, weights),
    loadModel(json, weights),
  ]);
  const n = featureOrder.feature_order.length;
  if (inputSize(global) !== n)
    throw new Error(
      `the model takes ${inputSize(global)} features, feature_order.json lists ${n}`,
    );
  since("startup.model", start);

  start = now();
  learner = new Learner(global, local);
  since("startup.learner", start);
  since("startup.total", startupStart);
  log.info(`learner ready in ${(now() - startupStart).toFixed(0)}ms`);
  return learner;
})();

// Thank god this is single threaded, other wise this would be concurrency hell lol
self.onmessage = async ({
  data: { id, message, relayedAt },
}: MessageEvent<{
  id: number;
  message: OffscreenRequest;
  relayedAt: number;
}>) => {
  const receivedAt = now();
  if ("restore" in message) {
    restoreRules(message.restore);
    self.postMessage({ id, reply: {} satisfies LearnerReply });
    return;
  }

  // SW sendMessage -> here, so includes the offscreen -> worker hop below
  if (message.sentAt !== undefined) since("hop.swToOffscreen", message.sentAt);
  // offscreen document's postMessage -> here
  since("hop.offscreenToWorker", relayedAt);

  let reply: LearnerReply;

  try {
    // TODO: puts us at the end of the eventQueue, suboptimal
    const learner = await learnerPromise;

    const probability = await learner.submit({
      features: Float64Array.from(message.features),
      site: message.site,
      label: message.label,
    });

    const block = probability >= THRESHOLD;
    log.trace(
      message.source,
      probability.toFixed(3),
      block ? "block" : "allow",
      message.request,
    );
    count(block ? "decision.block" : "decision.allow");

    const check = await checkLists;
    if (check) {
      const start = now();
      const blockedBy = check(message.req);
      since("filter-lists.match", start);
      const modelResponse = block ? "block" : "allow";
      const filterListResponse = blockedBy.length > 0 ? "block" : "allow";

      // confusion matrix per type, any list: filter-lists.<model>.<lists>.<type>
      count(`filter-lists.${modelResponse}.${filterListResponse}.${message.req.type}`);

      // per list: filter-lists.<list>.<model>.<type> when it blocks; it allowed the rest of filter-lists.<model>.*.<type>
      for (const name of blockedBy) {
        count(`filter-lists.${name}.${modelResponse}.${message.req.type}`);
      }

      if (block !== blockedBy.length > 0) {
        log.trace("lists disagree, blocked by:", blockedBy, message.request);
      }
    }

    // once per load: rule existed but request loaded (not installed yet / no match)
    if (rules.has(message.request)) count("block.loadedDespiteRule");

    let rule = undefined;
    if (message.blockable) {
      rule = ruleChange(message.request, block);
      // its request already loaded
      if (rule?.action === "add") count("rules.added");
      if (rule?.evict !== undefined) count("rules.evicted");
      if (rule?.action === "remove") count("rules.removed");
    } else if (block) {
      log.trace("block verdict, but not blockable", message.request);
      count("block.notBlockable");
    }
    // passing the block like this seems a bit awkward but it'll have to do for now
    reply = { block, rule, repliedAt: now() };
  } catch (error) {
    log.error(error);
    reply = { error: String(error) };
  }
  since("worker.handle", receivedAt);
  self.postMessage({ id, reply });
};
