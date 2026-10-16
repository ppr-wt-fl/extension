import {
  concat,
  dispose,
  tidy,
  type LayersModel,
  type Tensor,
} from "@tensorflow/tfjs";
import { flags } from "@/lib/flags";
import { gradient, inspectModes, predict, THRESHOLD } from "@/model";
import { logger } from "@/lib/log";
import { count, now, record, since, type LearnerSize } from "@/lib/perf";

const log = logger("learn");

export type LearnConfig = typeof flags.learn;

/** A labeled request to train on. */
export interface Sample {
  features: Float64Array;
  /** Top-level site: gradients are clipped per site, and limited to `perSiteLimit` samples per round */
  site: string;
  /** 1 to block, 0 to allow */
  label: 0 | 1;
}

interface Pending {
  features: Float64Array;
  /** `now()` at submit */
  submittedAt: number;
  resolve(probability: number): void;
  reject(error: unknown): void;
}

/**
 * Receives a round's clipped update, local - global, flattened in the order of the trainable weights.
 * TODO(secret sharing): split into 2 additive shares (S0, S1); measure fl.shareMs, fl.uploadBytes (~2 * updateBytes).
 */
export type SendUpdate = (update: Float32Array) => void;

/** Stub until there is an FL server. */
const logUpdate: SendUpdate = (update) => {
  let squared = 0;
  for (const value of update) squared += value * value;
  log.info(
    `round update: ${update.length} weights, norm ${Math.sqrt(squared).toFixed(4)}`,
  );
};

/** Batches requests and classifies each batch with one forward pass. */
export class Classifier {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `trainer` tells whether the local model has moved away from global this round. */
  constructor(
    private readonly global: LayersModel,
    private readonly local: LayersModel,
    private readonly trainer: { readonly steps: number },
    private readonly config: LearnConfig = flags.learn,
    /** fl.* metrics, flags.perf.fl. */
    private readonly measureFl = flags.perf.enabled && flags.perf.fl,
  ) {}

  /** Block probability of the features, once their batch is classified. */
  submit(features: Float64Array): Promise<number> {
    return new Promise((resolve, reject) => {
      // Queue
      // append
      // full -> flush
      // no timer -> start one and flush once it fills

      this.queue.push({ features, resolve, reject, submittedAt: now() });

      if (this.queue.length >= this.config.batchSize) {
        this.flush();
      } else if (this.timer === undefined) {
        this.timer = setTimeout(() => this.flush(), this.config.idleMs);
      }
    });
  }

  /** Classifies the queued requests. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;

    // empty queue
    const queued = this.queue.splice(0);
    if (!queued.length) return;

    // incl. idleMs + training slices
    for (const { submittedAt } of queued)
      since("learner.queueWait", submittedAt);
    record("learner.batchSize", queued.length);
    const features = queued.map((p) => p.features);

    try {
      let model = this.local;
      if (this.config.inferWith === "global") model = this.global;

      const start = now();
      const probabilities = predict(model, features);
      since("learner.infer", start);

      queued.forEach((p, i) => p.resolve(probabilities[i]));

      // before the first step local and global are the same
      if (this.measureFl && this.trainer.steps > 0) {
        this.disagreement(features, probabilities);
      }
    } catch (error) {
      // rejecting after the verdicts resolved does nothing, e.g. failed metrics
      log.error(error);
      count("learner.batchFailed");
      for (const p of queued) p.reject(error);
    }
  }

  /** State sizes, for perf. */
  sizes(): Record<"queue", number> {
    return { queue: this.queue.length };
  }

  /** Local vs global verdict disagreement on this batch. Costs a forward pass. */
  private disagreement(
    features: Float64Array[],
    probabilities: Float32Array,
  ): void {
    let model = this.global;
    if (this.config.inferWith === "global") model = this.local;
    const other = predict(model, features);
    let flipped = 0;
    let diff = 0;
    other.forEach((q, i) => {
      const p = probabilities[i];
      if (p >= THRESHOLD !== q >= THRESHOLD) flipped++;
      diff += Math.abs(p - q);
    });
    record("fl.disagreement", flipped / features.length);
    record("fl.probabilityDiff", diff / features.length);
  }
}

/**
 * Buffers labeled samples and takes one SGD step on every `miniBatchSize` of them (plus replayed ones), in slices of
 * `sliceRows` rows with `beforeSlice` (classifying the waiting requests) before each.
 * Every `roundSteps` steps it trains `epochs - 1` more times on the round's rows, sends the clipped local - global
 * update and starts over from global.
 * Everything is in memory (src/offscreen/worker.ts): lost when the browser or the extension restarts, so are the
 * buffered rows short of a step.
 */
export class Trainer {
  private buffer: Sample[] = [];
  private running = Promise.resolve();
  private readonly replay: Reservoir<Sample>;
  /** SGD steps this round */
  steps = 0;
  private perSite = new Map<string, number>();
  private trained = new Set<string>();
  /** Round start, `now()` */
  private roundStart = now();
  /** Training rows this round */
  private roundRows = 0;
  /** Fresh rows this round, for the later epochs */
  private roundSamples: Sample[] = [];
  readonly modes: { modeDependent: boolean; stateful: boolean };

  /** `global` and `local` are two copies of the same model, `local` is trained. */
  constructor(
    private readonly global: LayersModel,
    private readonly local: LayersModel,
    private readonly config: LearnConfig = flags.learn,
    private readonly beforeSlice: () => void = () => {},
    private readonly sendUpdate: SendUpdate = logUpdate,
    /** fl.* metrics, flags.perf.fl. Some need a backend sync. */
    private readonly measureFl = flags.perf.enabled && flags.perf.fl,
  ) {
    this.replay = new Reservoir(config.replayCapacity);
    // inspectModes costs 3 forward passes, and modeDependent only matters when training in training mode
    if (config.trainMode === "training") {
      this.modes = inspectModes(local);
    } else {
      this.modes = {
        modeDependent: false,
        stateful: local.nonTrainableWeights.length > 0,
      };
    }

    if (this.modes.stateful) {
      log.warn(
        "the model has non-trainable weights, the FL updates leave them out",
      );
    }
  }

  /** Buffers the sample if admitted. Resolves once the steps it started, and those before, are done. */
  add(sample: Sample): Promise<void> {
    if (this.admit(sample)) this.buffer.push(sample);

    if (this.buffer.length >= this.config.miniBatchSize) {
      const fresh = this.buffer.splice(0, this.config.miniBatchSize);
      this.running = this.running.then(async () => {
        try {
          await this.step(fresh);
        } catch (error) {
          log.error(error);
          count("learner.stepFailed");
        }
      });
    }
    return this.running;
  }

  /** State sizes, for perf. */
  sizes(): Record<Exclude<LearnerSize, "queue">, number> {
    return {
      buffer: this.buffer.length,
      replay: this.replay.items.length,
      trained: this.trained.size,
      perSite: this.perSite.size,
      steps: this.steps,
    };
  }

  private async step(fresh: Sample[]): Promise<void> {
    const stepStart = now();
    const fraction = this.config.replayFraction;
    const replayed = this.replay.sample(
      Math.round((fresh.length * fraction) / (1 - fraction)),
    );
    const rows = [...fresh, ...replayed];
    const loss = await this.descend(rows);
    for (const row of fresh) {
      this.replay.add(row);
      this.roundSamples.push(row);
    }

    this.steps++;
    log.debug(
      `step ${this.steps}/${this.config.roundSteps}: ${fresh.length} + ${replayed.length} replayed rows, loss ${(loss / rows.length).toFixed(4)}`,
    );
    since("learner.batch", stepStart);
    if (this.steps < this.config.roundSteps) return;

    // no replay: shuffling already mixes the round's sites into each mini-batch
    for (let epoch = 1; epoch < this.config.epochs; epoch++) {
      for (const batch of chunks(
        shuffle(this.roundSamples),
        this.config.miniBatchSize,
      )) {
        await this.descend(batch);
      }
    }
    this.endRound();
  }

  /** One SGD step on the rows, clipped per site. Returns the summed loss, with `measureFl`. */
  private async descend(rows: Sample[]): Promise<number> {
    record("learner.trainRows", rows.length);
    this.roundRows += rows.length;
    const training = this.config.trainMode === "training";

    // replayed rows join their site's group, so it is clipped as one. Without siteClip, one group: fewer passes
    const siteClip = this.config.siteClip;
    const bySite = new Map<string, Sample[]>();

    if (siteClip === undefined) {
      bySite.set("", rows);
    } else {
      for (const row of rows) {
        let key = row.site;
        const group = bySite.get(key);

        if (group) group.push(row);
        else bySite.set(key, [row]);
      }
    }

    let total: Tensor[] | undefined;
    let site: Tensor[] | undefined;
    let loss = 0;
    let busy = 0;
    // a failed pass or step would leak the gradients summed so far. Disposing twice is a no-op
    try {
      for (const group of bySite.values()) {
        for (const slice of chunks(group, this.config.sliceRows)) {
          await yieldToEvents();

          this.beforeSlice();
          const start = now();
          const result = gradient(
            this.local,
            slice.map((r) => r.features),
            slice.map((r) => r.label),
            training,
            this.measureFl,
          );
          busy += now() - start;
          loss += result.loss;
          site = add(site, result.grads);
        }

        if (siteClip === undefined) {
          total = add(total, site!);
        } else {
          if (this.measureFl) {
            const norm = globalNorm(site!);
            record("fl.siteGradNorm", norm);
            record("fl.siteClipped", Number(norm > siteClip));
          }
          total = add(total, clip(site!, siteClip));
        }
        // added to total, which frees it
        site = undefined;
      }
      // the passes only, without the verdicts in between
      record("learner.train", busy);
      if (this.measureFl) record("fl.loss", loss / rows.length);

      this.sgd(total!, rows.length);
    } finally {
      dispose([...(site ?? []), ...(total ?? [])]);
    }
    return loss;
  }

  /** SGD step: weight -= learningRate * summed (site-clipped) gradient / rows. Disposes `total`. */
  private sgd(total: Tensor[], rows: number): void {
    const stepSize = this.config.learningRate / rows;
    this.local.trainableWeights.forEach((weight, i) => {
      const updated = tidy(() => weight.read().sub(total[i].mul(stepSize)));
      weight.write(updated);
      updated.dispose();
    });
    dispose(total);
  }

  /**
   * Whether a sample may be trained on: its site is under `perSiteLimit`, and no identical row (same features and
   * label, so the same gradient) was trained on this round, e.g. the same request seen by several sources.
   */
  private admit(sample: Sample): boolean {
    // TODO: this keys might take up too much memory, but they'll be cleaned up at the end of a round
    const key = `${sample.label}:${sample.features.join(",")}`;
    const admitted = this.perSite.get(sample.site) ?? 0;

    if (this.trained.has(key)) {
      if (this.measureFl) count("fl.rejectedDuplicate");
      return false;
    }

    if (admitted >= this.config.perSiteLimit) {
      // once per site and round
      if (admitted === this.config.perSiteLimit) {
        log.debug(
          `${sample.site} reached perSiteLimit, no more training rows this round`,
        );
        this.perSite.set(sample.site, admitted + 1);
      }
      if (this.measureFl) count("fl.rejectedPerSite");
      return false;
    }

    this.trained.add(key);
    this.perSite.set(sample.site, admitted + 1);
    return true;
  }

  /** Sends the clipped update and resets the local model to the global one. Buffered rows train next round. */
  endRound(): void {
    const update = tidy(() => {
      const deltas = this.local.trainableWeights.map((w, i) =>
        w.read().sub(this.global.trainableWeights[i].read()).flatten(),
      );
      const flat = concat(deltas);
      if (this.measureFl) {
        const norm = globalNorm([flat]);
        record("fl.updateNorm", norm);
        record("fl.updateClipped", Number(norm > this.config.updateClip));
      }
      return clip([flat], this.config.updateClip)[0];
    });
    const data = update.dataSync() as Float32Array;
    update.dispose();
    if (this.measureFl) {
      since("fl.roundMs", this.roundStart);
      record("fl.roundRows", this.roundRows);
      // plaintext; TODO(secret sharing): share sizes instead
      record("fl.updateBytes", data.byteLength);
    }
    // TODO(secret sharing): time share + upload (fl.shareMs, fl.uploadMs)
    log.info(
      `round over: ${this.steps} steps, ${this.roundRows} rows, ${((now() - this.roundStart) / 1000).toFixed(1)}s`,
    );
    this.sendUpdate(data);
    this.roundStart = now();
    this.roundRows = 0;
    this.local.setWeights(this.global.getWeights());
    this.steps = 0;
    this.perSite.clear();
    this.trained.clear();
    this.roundSamples = [];
  }
}

/** Joint L2 norm, to call inside `tidy`. */
function l2(tensors: Tensor[]): Tensor {
  return tensors
    .map((t) => t.square().sum())
    .reduce((a, b) => a.add(b))
    .sqrt();
}

/** Joint L2 norm. Doesn't dispose input. */
function globalNorm(tensors: Tensor[]): number {
  return tidy(() => l2(tensors).dataSync()[0]);
}

/** Sum of two gradients, disposing both. */
function add(a: Tensor[] | undefined, b: Tensor[]): Tensor[] {
  if (!a) return b;
  const sum = tidy(() => a.map((t, i) => t.add(b[i])));
  dispose([...a, ...b]);
  return sum;
}

/** The tensors scaled to a joint L2 norm of at most `max`, disposing the input. */
function clip(tensors: Tensor[], max: number): Tensor[] {
  const clipped = tidy(() => {
    const scale = l2(tensors).maximum(max).reciprocal().mul(max);
    return tensors.map((t) => t.mul(scale));
  });
  dispose(tensors);
  return clipped;
}

function chunks<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

/** Lets requests arrive between training slices, so `beforeSlice` classifies them: tfjs passes block the thread. */
function yieldToEvents(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** Uniform sample of everything added so far, at most `capacity` items (Vitter's algorithm R). */
export class Reservoir<T> {
  readonly items: T[] = [];
  private seen = 0;

  constructor(private readonly capacity: number) {}

  add(item: T): void {
    this.seen++;
    if (this.items.length < this.capacity) {
      this.items.push(item);
    } else {
      const i = Math.floor(Math.random() * this.seen);
      if (i < this.capacity) this.items[i] = item;
    }
  }

  /** `k` distinct items, fewer if it holds fewer. */
  sample(k: number): T[] {
    return shuffle(this.items, k);
  }
}

/** `k` (default all) distinct items in random order, a partial Fisher-Yates shuffle of a copy. */
function shuffle<T>(items: readonly T[], k = items.length): T[] {
  const pool = [...items];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
