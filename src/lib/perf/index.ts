import { flags } from "@/lib/flags";
import { outboxSink } from "./outbox";
import { logger } from "../log";

const log = logger("perf");

// Perf metrics. Every context buffers samples -> sink, which writes them raw to IndexedDB (./outbox); analysed offline.
// Prefix = where taken: sw, hop, worker/learner, block/rules/decision/sources, page, startup, fl, offscreen; or what:
// tf, model, features, filter-lists.
// Durations ms, sizes bytes. Counter = samples of 1.

/** Epoch ms, sub-ms resolution, comparable across contexts. */
export function now(): number {
  return performance.timeOrigin + performance.now();
}

type Verdict = "block" | "allow";
/** keys of Classifier.sizes() and Trainer.sizes() */
export type LearnerSize =
  | "queue"
  | "buffer"
  | "replay"
  | "trained"
  | "perSite"
  | "steps";
/** chrome.webRequest resource type */
type ResourceType = string;

/** Every metric recorded. record/count/gauge/since only take these. */
export type Metric =
  // browser / service worker lifecycle
  | "browser.starts"
  | "sw.starts"
  | "sw.listenerFailed"
  | "sw.requestsCompleted"
  | "sw.eventDelay"
  | "sw.topLevelUrl"
  // collect (src/lib/collect)
  | `sw.observations.${"webRequest" | "refetch"}`
  | `sw.bodyMissing.${ResourceType}`
  | `sw.features.${ResourceType}`
  | `sw.featuresBodyChars.${ResourceType}`
  | "sw.ready"
  | "sw.offscreenCreate"
  | "sw.offscreenSetupFailed"
  | "sw.offscreenUnreachable"
  | "sw.offscreenClosing"
  | "sw.learnerFailed"
  | "sw.timeToVerdict"
  // refetch
  | "sw.refetch"
  | "sw.refetchBytes"
  | "sw.refetchFailed"
  | "sw.refetchSkipped"
  // cache (src/background/checked)
  | `cache.${"inflight" | "run-from-scratch" | "fresh" | "needs-body-validation"}`
  | "cache.validatorHit"
  | "cache.bodyHit"
  | "cache.evicted"
  | "cache.saveFailed"
  | "cache.size"
  | "sw.cacheLoad"
  | "sw.cacheSave"
  // blocking rules
  | "sw.ruleUpdate"
  | "sw.ruleFlush"
  | "sw.timeToRule"
  | "rules"
  | "rules.added"
  | "rules.evicted"
  | "rules.removed"
  | "block.hits"
  | "block.loadedDespiteRule"
  | "block.notBlockable"
  | "block.siteDisabledByUser"
  | "block.siteReenabledByUser"
  | "block.breakageReported"
  | "block.adSeenReported"
  // message hops
  | "hop.swToOffscreen"
  | "hop.offscreenToWorker"
  | "hop.workerToSw"
  // offscreen / worker
  | "offscreen.creations"
  | "offscreen.heapUsed"
  | "offscreen.heapTotal"
  | "worker.handle"
  | "worker.gaugesFailed"
  | "worker.listsFailed"
  | `decision.${Verdict}`
  // startup
  | "startup.backend"
  | "startup.model"
  | "startup.learner"
  | "startup.lists"
  | "startup.total"
  // sizes
  | "features.wasmBytes"
  | "tf.numTensors"
  | "tf.numBytes"
  | "tf.wasmBytes"
  | "model.weightsBytes"
  | "model.jsonBytes"
  // filter lists: confusion matrix filter-lists.<model>.<lists>.<type>, per list filter-lists.<list>.<model>.<type>
  | "filter-lists.match"
  | "filter-lists.wasmBytes"
  | `filter-lists.${string}.${Verdict}.${ResourceType}`
  // learner
  | `learner.${LearnerSize}`
  | "learner.batchFailed"
  | "learner.stepFailed"
  | "learner.queueWait"
  | "learner.batchSize"
  | "learner.infer"
  | "learner.batch"
  | "learner.trainRows"
  | "learner.train"
  // federated learning, flags.perf.fl
  | "fl.siteGradNorm"
  | "fl.siteClipped"
  | "fl.loss"
  | "fl.disagreement"
  | "fl.probabilityDiff"
  | "fl.rejectedDuplicate"
  | "fl.rejectedPerSite"
  | "fl.updateNorm"
  | "fl.updateClipped"
  | "fl.roundMs"
  | "fl.roundRows"
  | "fl.updateBytes";

/** `at`: `now()` when recorded */
export type Sample = [name: string, value: number, at: number];

let buffer: Sample[] = [];
let sink: ((samples: Sample[]) => void) | undefined;
let delayMs = 0;
let scheduled = false;

// FIXME: not a huge fan of this sink setup
/** Where samples go, after `delay` ms. Unset: buffered (tests), up to flags.perf.maxBuffer. */
export function initSink(name: string, delay = flags.perf.flushMs) {
  sink = outboxSink(name);
  delayMs = delay;
  schedule();
}

export function record(name: Metric, value: number) {
  if (!flags.perf.enabled) return;

  if (sink === undefined)
    log.warn("perf.record() called before initSink()", name, value);

  if (buffer.length >= flags.perf.maxBuffer) buffer.shift();
  buffer.push([name, value, now()]);
  schedule();
}

const gauges = new Map<Metric, number>();

/** Records a current size, only when it changed since the last call. */
export function gauge(name: Metric, value: number) {
  if (gauges.get(name) === value) return;
  gauges.set(name, value);
  record(name, value);
}

export function count(name: Metric, n = 1) {
  record(name, n);
}

/** Records time since `start` (a `now()`), + User Timing entry with flags.perf.trace. */
export function since(name: Metric, start: number): number {
  const end = now();
  record(name, end - start);
  if (flags.perf.enabled && flags.perf.trace) {
    performance.measure(name, {
      start: Math.max(0, start - performance.timeOrigin),
      end: end - performance.timeOrigin,
    });
  }
  return end - start;
}

function schedule() {
  if (scheduled || !sink || buffer.length === 0) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    const samples = buffer;
    buffer = [];
    sink?.(samples);
  }, delayMs);
}

/** One flush of one context in the outbox. Names interned per record: `ids` index `names`. */
export interface OutboxRecord {
  ctx: string;
  /** Random per context start */
  instance: string;
  /** Epoch ms of the first sample */
  t0: number;
  names: string[];
  ids: Uint16Array;
  values: Float64Array;
  /** ms since t0 */
  dt: Float32Array;
}

export function encode(
  samples: Sample[],
  ctx: string,
  instance: string,
): OutboxRecord {
  const t0 = samples[0]?.[2] ?? now();
  const index = new Map<string, number>();
  const ids = new Uint16Array(samples.length);
  const values = new Float64Array(samples.length);
  const dt = new Float32Array(samples.length);
  samples.forEach(([name, value, at], i) => {
    let id = index.get(name);
    if (id === undefined) index.set(name, (id = index.size));
    ids[i] = id;
    values[i] = value;
    dt[i] = at - t0;
  });
  return { ctx, instance, t0, names: [...index.keys()], ids, values, dt };
}

/** One row per sample, for export. */
export function* decode(record: OutboxRecord) {
  const { ctx, instance, t0, names, ids, values, dt } = record;
  for (let i = 0; i < ids.length; i++) {
    yield {
      t: t0 + dt[i],
      ctx,
      instance,
      name: names[ids[i]],
      value: values[i],
    };
  }
}
