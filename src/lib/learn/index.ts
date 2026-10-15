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
import { count, now, record, since } from "@/lib/perf";

const log = logger("learn");

export type LearnConfig = typeof flags.learn;

/** A request to classify, and to train on if it has a label. */
export interface Sample {
  features: Float64Array;
  /** Top-level site: gradients are clipped per site, and limited to `perSiteLimit` samples per round */
  site: string;
  /** 1 to block, 0 to allow, undefined to only classify */
  label?: 0 | 1;
}

/** A sample being trained on. */
interface Row extends Sample {
  label: 0 | 1;
  /** Position in the flushed queue, undefined for replayed rows */
  index?: number;
}

interface Pending {
  sample: Sample;
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

/**
 * Batches requests, classifies them, and takes one SGD step on each batch's labeled rows (plus replayed ones).
 * The forward pass that computes a row's gradient also classifies it when the weights and mode allow it.
 * Every `roundSteps` steps it sends the clipped local - global update and starts over from global.
 * Everything is in memory (src/offscreen/worker.ts): lost when the browser or the extension restarts.
 */
export class Learner {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = Promise.resolve();
  private readonly replay: Reservoir<Row>;
  private steps = 0;
  private perSite = new Map<string, number>();
  private trained = new Set<string>();
  /** Round start, `now()` */
  private roundStart = now();
  /** Training rows this round */
  private roundRows = 0;
  readonly modes: { modeDependent: boolean; stateful: boolean };

  /** `global` and `local` are two copies of the same model, `local` is trained. */
  constructor(
    private readonly global: LayersModel,
    private readonly local: LayersModel,
    private readonly config: LearnConfig = flags.learn,
    private readonly sendUpdate: SendUpdate = logUpdate,
    /** fl.* metrics, flags.perf.fl. Some need a backend sync. */
    private readonly measureFl = flags.perf.enabled && flags.perf.fl,
  ) {
    this.replay = new Reservoir(config.replayCapacity);
    this.modes = inspectModes(local);

    if (this.modes.stateful) {
      log.warn(
        "the model has non-trainable weights, the FL updates leave them out",
      );
    }
  }

  /** Submit samples for inference and training */
  submit(sample: Sample): Promise<number> {
    return new Promise((resolve, reject) => {
      // add to queue
      this.queue.push({ sample, resolve, reject, submittedAt: now() });

      // queue handling (idle time + max capacity)
      clearTimeout(this.timer);
      if (this.queue.length >= this.config.batchSize) {
        this.flush();
      } else {
        this.timer = setTimeout(() => this.flush(), this.config.idleMs);
      }
    });
  }

  /** Classifies and trains on the queued requests, after the batches before them. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const queued = this.queue.splice(0);

    this.running = this.running.then(async () => {
      try {
        await this.run(queued);
      } catch (error) {
        // rejecting after the verdicts resolved does nothing, e.g. a failed SGD step
        log.error(error);
        for (const sample of queued) {
          sample.reject(error);
        }
      }
    });

    return this.running;
  }

  /** State sizes, for perf. */
  sizes(): Record<string, number> {
    return {
      queue: this.queue.length,
      replay: this.replay.items.length,
      trained: this.trained.size,
      perSite: this.perSite.size,
      steps: this.steps,
    };
  }

  private async run(queued: Pending[]): Promise<void> {
    const batchStart = now();
    // incl. idleMs + earlier batches
    for (const { submittedAt } of queued) since("learner.queueWait", submittedAt);
    record("learner.batchSize", queued.length);

    // Get samples for training
    const fresh: Row[] = [];
    for (let index = 0; index < queued.length; index++) {
      const { sample } = queued[index];

      if (sample.label !== undefined && this.admit(sample)) {
        fresh.push({ ...sample, label: sample.label, index });
      }
    }

    // Add replay samples
    const replayFraction = this.config.replayFraction;
    const replayed = fresh.length
      ? this.replay.sample(
          Math.round((fresh.length * replayFraction) / (1 - replayFraction)),
        )
      : [];
    const samples = [...fresh, ...replayed];
    if (samples.length) record("learner.trainRows", samples.length);

    // Determine how we're running the model
    const training = this.config.trainMode === "training";
    let reuseInferencePass = true;
    if (training && this.modes.modeDependent) {
      // Dropout etc. were active, the probabilities are noisy
      reuseInferencePass = false;
    }
    if (this.config.inferWith === "global" && this.steps > 0) {
      // the training pass ran the local weights, which have moved away from global
      reuseInferencePass = false;
    }

    const probabilities = new Float32Array(queued.length).fill(NaN);
    let start = now();
    let loss = 0;

    // Split data into sites
    let total: Tensor[] | undefined;
    const bySite = new Map<string, Row[]>();
    for (const s of samples) {
      (bySite.get(s.site) ?? bySite.set(s.site, []).get(s.site)!).push(s);
    }

    for (const group of bySite.values()) {
      let site: Tensor[] | undefined;
      for (const chunk of chunks(group, this.config.chunkSize)) {
        const {
          grads,
          probabilities: chunkProbabilities,
          loss: chunkLoss,
        } = gradient(
          this.local,
          chunk.map((s) => s.features),
          chunk.map((s) => s.label),
          training,
          this.measureFl,
        );
        loss += chunkLoss;

        if (reuseInferencePass) {
          for (let i = 0; i < chunk.length; i++) {
            const { index } = chunk[i];

            if (index !== undefined)
              probabilities[index] = chunkProbabilities[i];
          }
        }

        site = add(site, grads);
        await yieldToEvents();
      }

      if (this.measureFl) {
        const norm = globalNorm(site!);
        record("fl.siteGradNorm", norm);
        record("fl.siteClipped", Number(norm > this.config.siteClip));
      }
      total = add(total, clip(site!, this.config.siteClip));
    }
    if (samples.length) since("learner.train", start);
    if (this.measureFl && samples.length)
      record("fl.loss", loss / samples.length);

    // classify the requests the training pass gave no verdict for
    let classifier = this.local;
    if (this.config.inferWith === "global" && this.steps > 0) {
      classifier = this.global;
    }

    // Get samples which still have inference pending (the ones not used for training)
    const unclassified: number[] = [];
    for (let i = 0; i < probabilities.length; i++) {
      if (Number.isNaN(probabilities[i])) unclassified.push(i);
    }

    // Run unclassified samples
    // TODO: i'm not convinced this is a super clean way of running it, this sort of split
    start = now();
    for (const chunk of chunks(unclassified, this.config.chunkSize)) {
      const chunkFeatures = chunk.map(
        (queueIndex) => queued[queueIndex].sample.features,
      );
      const chunkProbabilities = predict(classifier, chunkFeatures);

      for (let i = 0; i < chunk.length; i++) {
        const queueIndex = chunk[i];
        probabilities[queueIndex] = chunkProbabilities[i];
      }
      await yieldToEvents();
    }
    if (unclassified.length) since("learner.infer", start);

    for (let i = 0; i < queued.length; i++) {
      queued[i].resolve(probabilities[i]);
    }

    if (this.measureFl && this.steps > 0) this.disagreement(queued, probabilities);

    // no training rows: nothing to update
    if (!total) return;

    // SGD step: weight -= learningRate * summed (site-clipped) gradient / rows
    const stepSize = this.config.learningRate / samples.length;
    const weights = this.local.trainableWeights;
    for (let i = 0; i < weights.length; i++) {
      const weightGradient = total[i];
      const updated = tidy(() =>
        weights[i].read().sub(weightGradient.mul(stepSize)),
      );
      weights[i].write(updated);
      updated.dispose();
    }
    dispose(total);

    // replayed rows are stored without their position in this batch's queue
    for (const row of fresh) {
      this.replay.add({ ...row, index: undefined });
    }

    this.steps++;
    this.roundRows += samples.length;
    log.debug(
      `step ${this.steps}/${this.config.roundSteps}: ${queued.length} requests, ${fresh.length} + ${replayed.length} replayed rows, loss ${(loss / samples.length).toFixed(4)}`,
    );
    since("learner.batch", batchStart);
    if (this.steps >= this.config.roundSteps) {
      this.endRound();
    }
  }

  /** Local vs global verdict disagreement on this batch. Costs a forward pass. */
  private disagreement(queued: Pending[], probabilities: Float32Array): void {
    const other =
      this.config.inferWith === "global" ? this.local : this.global;
    let flipped = 0;
    let diff = 0;
    let offset = 0;
    for (const chunk of chunks(queued, this.config.chunkSize)) {
      const otherProbabilities = predict(
        other,
        chunk.map((p) => p.sample.features),
      );
      for (let i = 0; i < chunk.length; i++) {
        const p = probabilities[offset + i];
        const q = otherProbabilities[i];
        if (p >= THRESHOLD !== q >= THRESHOLD) flipped++;
        diff += Math.abs(p - q);
      }
      offset += chunk.length;
    }
    record("fl.disagreement", flipped / queued.length);
    record("fl.probabilityDiff", diff / queued.length);
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
        log.debug(`${sample.site} reached perSiteLimit, no more training rows this round`);
        this.perSite.set(sample.site, admitted + 1);
      }
      if (this.measureFl) count("fl.rejectedPerSite");
      return false;
    }

    this.trained.add(key);
    this.perSite.set(sample.site, admitted + 1);
    return true;
  }

  /** Sends the clipped update and resets the local model to the global one. */
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
    log.info(`round over: ${this.steps} steps, ${this.roundRows} rows, ${((now() - this.roundStart) / 1000).toFixed(1)}s`);
    this.sendUpdate(data);
    this.roundStart = now();
    this.roundRows = 0;
    this.local.setWeights(this.global.getWeights());
    this.steps = 0;
    this.perSite.clear();
    this.trained.clear();
  }
}

/** Joint L2 norm. Doesn't dispose input. */
function globalNorm(tensors: Tensor[]): number {
  const norm = tidy(() =>
    tensors
      .map((t) => t.square().sum())
      .reduce((a, b) => a.add(b))
      .sqrt(),
  );
  const value = norm.dataSync()[0];
  norm.dispose();
  return value;
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
    const norm = tensors
      .map((t) => t.square().sum())
      .reduce((a, b) => a.add(b))
      .sqrt();
    const scale = norm.maximum(max).reciprocal().mul(max);
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

/**
 * Lets queued messages run between chunks, as tfjs passes block the thread.
 * NOTE: likely unneeded in the worker (src/offscreen/worker.ts): its messages only queue, and wait for this batch anyway.
 */
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
    const pool = [...this.items];
    const n = Math.min(k, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }
}
