import { env, io, setBackend } from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import tfWasmUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url";
import tfSimdUrl from "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url";
import type { Source } from "@/collect";
import { flags } from "@/flags";
import { Learner } from "@/learn";
import { inputSize, loadModel } from "@/model";
// FIXME: copy the model into this repo instead of importing it from the robustness-evaluation run
import modelJson from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/model.json";
import featureOrder from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/feature_order.json";
import weightsUrl from "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/group1-shard1of1.bin?url";

// Holds the state that should outlive the service worker, which Chrome stops when idle: the learner and the
// verdicts. Lost when the browser or the extension restarts.

/** One observation of a request, from the service worker. */
export interface LearnerRequest {
  target: "offscreen";
  /** Identifies the request across its sources */
  request: string;
  source: Source;
  features: number[];
  /** Top-level site of the request */
  site: string;
  /** Training label, undefined to only classify */
  label?: 0 | 1;
}

export type LearnerReply = { block: boolean } | { error: string };

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

/** Probability at or above which a request is blocked. */
const THRESHOLD = 0.5;

/** Latest verdict of each source, by request. Grows until the offscreen document closes. */
const verdicts = new Map<string, Map<Source, boolean>>();

/** Whether to block a request, from its sources' verdicts, as set by `flags.reconcile`. */
function decide(bySource: Map<Source, boolean>): boolean {
  if (flags.reconcile === "any") return [...bySource.values()].some(Boolean);
  const best = [...bySource.keys()].reduce((a, b) =>
    BODY_RANK[b] > BODY_RANK[a] ? b : a,
  );
  return bySource.get(best)!;
}

const learnerPromise = (async () => {
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
  return new Learner(global, local);
})();

self.onmessage = async ({
  data: { id, message },
}: MessageEvent<{ id: number; message: LearnerRequest }>) => {
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

    verdicts.set(
      message.request,
      bySource.set(message.source, probability >= THRESHOLD),
    );

    // NOTE: We might add/remove a rule a couple of times
    reply = { block: decide(bySource) };
  } catch (error) {
    reply = { error: String(error) };
  }
  self.postMessage({ id, reply });
};
