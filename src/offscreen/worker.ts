import { env, io, memory, setBackend } from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import tfWasmUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url";
import tfSimdUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url";
import type { Source } from "@/collect";
import { flags } from "@/flags";
import { Learner } from "@/learn";
import { inputSize, loadModel, THRESHOLD } from "@/model";
import {
  count,
  Metrics,
  now,
  setSink,
  since,
  type PerfReport,
  type Snapshot,
  type SnapshotRequest,
} from "@/perf";
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

export type OffscreenRequest =
  LearnerRequest | RestoreRequest | PerfReport | SnapshotRequest;

/** A block rule the service worker adds or removes. */
export interface RuleChange {
  action: "add" | "remove";
  id: number;
}

// TODO: feels like this type shouldn't live here
/** `rule` is set when the request's decision changed. `repliedAt`: `now()`, for hop.* */
export type LearnerReply =
  | { rule?: RuleChange; repliedAt?: number }
  | { error: string };

export type OffscreenReply = LearnerReply | Snapshot;

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

/** Latest verdict of each source, by request. Grows until the offscreen document closes. */
const verdicts = new Map<string, Map<Source, boolean>>();

/**
 * Id of the block rule of each request key that has one. The decision only changes the rules when it changes, as
 * every source of a request sends its own verdict.
 * TODO: evict old rules before chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES, adding fails past it
 */
const rules = new Map<string, number>();
let nextRuleId = 1;

/** The rule change a request's decision needs, if any. */
function ruleChange(key: string, block: boolean): RuleChange | undefined {
  const id = rules.get(key);
  if (block && id === undefined) {
    const id = nextRuleId++;
    rules.set(key, id);
    return { action: "add", id };
  }
  if (!block && id !== undefined) {
    rules.delete(key);
    return { action: "remove", id };
  }
}

/** Whether to block a request, from its sources' verdicts, as set by `flags.reconcile`. */
function decide(bySource: Map<Source, boolean>): boolean {
  if (flags.reconcile === "any") return [...bySource.values()].some(Boolean);
  const best = [...bySource.keys()].reduce((a, b) =>
    BODY_RANK[b] > BODY_RANK[a] ? b : a,
  );
  return bySource.get(best)!;
}

/** All contexts' metrics. Lost with offscreen doc. */
const metrics = new Metrics();
setSink((samples) => metrics.add(samples));

let learner: Learner | undefined;

function snapshot(): Snapshot {
  const tf = memory();
  return {
    since: metrics.since,
    metrics: metrics.summary(),
    gauges: {
      verdicts: verdicts.size,
      rules: rules.size,
      // growing = leak
      "tf.numTensors": tf.numTensors,
      "tf.numBytes": tf.numBytes,
      ...Object.fromEntries(
        Object.entries(learner?.sizes() ?? {}).map(([k, v]) => [
          `learner.${k}`,
          v,
        ]),
      ),
    },
  };
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
}: MessageEvent<{ id: number; message: OffscreenRequest; relayedAt: number }>) => {
  const receivedAt = now();
  if ("perf" in message) {
    metrics.add(message.perf);
    self.postMessage({ id, reply: {} satisfies LearnerReply });
    return;
  }
  if ("snapshot" in message) {
    self.postMessage({ id, reply: snapshot() });
    if (message.reset) metrics.reset();
    return;
  }
  if ("restore" in message) {
    for (const rule of message.restore) {
      rules.set(rule.key, rule.id);
      nextRuleId = Math.max(nextRuleId, rule.id + 1);
    }
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

    verdicts.set(
      message.request,
      bySource.set(message.source, probability >= THRESHOLD),
    );

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
