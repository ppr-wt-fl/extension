import { env, io, memory, setBackend } from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import tfWasmUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url";
import tfSimdUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url";
import type { Source } from "@/collect";
import { flags } from "@/flags";
import { Learner } from "@/learn";
import { inputSize, loadModel, THRESHOLD } from "@/model";
import { count, gauge, now, setSink, since } from "@/perf";
import { outboxSink } from "@/perf/outbox";
import {
  decide,
  restoreRules,
  type RuleChange,
  ruleChange,
  rules,
} from "./rules";
// FIXME: copy the model into this repo instead of importing it from the robustness-evaluation run
import modelJson from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/model.json";
import featureOrder from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/feature_order.json";
import weightsUrl from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/group1-shard1of1.bin?url";

// Holds the state that should outlive the service worker, which Chrome stops when idle: the learner, the
// verdicts and the block rules' ids. Lost when the browser or the extension restarts, except the rules (src/block).

/** One observation of a request, from the service worker. */
export interface LearnerRequest {
  target: "offscreen";
  /** Identifies the request across its sources, `ruleKey` in src/block */
  request: string;
  /** Whether the request can get a block rule, `blockable` in src/block */
  blockable: boolean;
  source: Source;
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
/** `rule` is set when the request's decision changed. `repliedAt`: `now()`, for hop.* */
export type LearnerReply =
  { rule?: RuleChange; repliedAt?: number } | { error: string };

/** Latest verdict of each source, by request, least recently observed first. */
const verdicts = new Map<string, Map<Source, boolean>>();
const MAX_VERDICTS = 50_000;

setSink(outboxSink("worker"), flags.perf.flushMs);

let learner: Learner | undefined;

// Gauges: current sizes, as a sample when they change
if (flags.perf.enabled) {
  setInterval(() => {
    const tf = memory();
    gauge("verdicts", verdicts.size);
    gauge("rules", rules.size);
    // growing = leak
    gauge("tf.numTensors", tf.numTensors);
    gauge("tf.numBytes", tf.numBytes);
    for (const [k, v] of Object.entries(learner?.sizes() ?? {}))
      gauge(`learner.${k}`, v);
  }, flags.perf.flushMs);
}

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

    const bySource =
      verdicts.get(message.request) ?? new Map<Source, boolean>();
    const before = bySource.size > 0 ? decide(bySource) : undefined;

    // re-inserted to move it to the end, so the least recently observed is evicted
    verdicts.delete(message.request);
    verdicts.set(
      message.request,
      bySource.set(message.source, probability >= THRESHOLD),
    );
    if (verdicts.size > MAX_VERDICTS) {
      verdicts.delete(verdicts.keys().next().value!);
    }

    const block = decide(bySource);
    count(block ? "decision.block" : "decision.allow");
    if (before !== undefined && before !== block) count("decision.flips");
    if (new Set(bySource.values()).size > 1) count("sources.disagree");

    // once per load: rule existed but request loaded (not installed yet / no match)
    if (
      rules.has(message.request) &&
      (message.source === "webRequest" || message.source === "refetch")
    )
      count("block.loadedDespiteRule");

    let rule = undefined;
    if (message.blockable) {
      rule = ruleChange(message.request, block);
      // its request already loaded
      if (rule?.action === "add") count("rules.added");
      if (rule?.evict !== undefined) count("rules.evicted");
      if (rule?.action === "remove") count("rules.removed");
    } else if (block) {
      count("block.notBlockable");
    }
    reply = { rule, repliedAt: now() };
  } catch (error) {
    reply = { error: String(error) };
  }
  since("worker.handle", receivedAt);
  self.postMessage({ id, reply });
};
