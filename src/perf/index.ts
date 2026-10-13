import { flags } from "@/flags";

// Perf metrics. Every context buffers samples -> sink; worker aggregates them in `Metrics`.
// Prefix = where taken: sw, hop, worker/learner, block/rules/decision/sources, page, startup, fl.
// Durations ms, sizes bytes. Counter = samples of 1.

/** Epoch ms, sub-ms resolution, comparable across contexts. */
export function now(): number {
  return performance.timeOrigin + performance.now();
}

export type Sample = [name: string, value: number];

let buffer: Sample[] = [];
let sink: ((samples: Sample[]) => void) | undefined;
let delayMs = 0;
let scheduled = false;

// FIXME: not a huge fan of this sink setup
/** Where samples go, after `delay` ms. Unset: buffered (tests). */
export function setSink(fn: (samples: Sample[]) => void, delay = 0) {
  sink = fn;
  delayMs = delay;
  schedule();
}

export function record(name: string, value: number) {
  if (!flags.perf.enabled) return;
  if (buffer.length >= flags.perf.window) buffer.shift();
  buffer.push([name, value]);
  schedule();
}

export function count(name: string, n = 1) {
  record(name, n);
}

/** Records time since `start` (a `now()`), + User Timing entry with flags.perf.trace. */
export function since(name: string, start: number): number {
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

/** Percentiles over last `flags.perf.window` samples. */
export interface Summary {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

class Stat {
  count = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  last = NaN;
  private readonly window: Float64Array;
  private next = 0;

  constructor(size: number) {
    this.window = new Float64Array(size);
  }

  add(value: number) {
    this.count++;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    this.last = value;
    this.window[this.next++ % this.window.length] = value;
  }

  summary(): Summary {
    const sorted = this.window
      .slice(0, Math.min(this.count, this.window.length))
      .sort();
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      last: this.last,
      mean: this.sum / this.count,
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
    };
  }
}

/** Aggregates samples by name. */
export class Metrics {
  private stats = new Map<string, Stat>();
  since = Date.now();

  add(samples: Sample[]) {
    for (const [name, value] of samples) {
      if (!Number.isFinite(value)) continue;
      let stat = this.stats.get(name);
      if (!stat) this.stats.set(name, (stat = new Stat(flags.perf.window)));
      stat.add(value);
    }
  }

  summary(): Record<string, Summary> {
    return Object.fromEntries(
      [...this.stats]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, stat]) => [name, stat.summary()]),
    );
  }

  reset() {
    this.stats.clear();
    this.since = Date.now();
  }
}

/** Samples sent to the worker. */
export interface PerfReport {
  target: "offscreen";
  perf: Sample[];
}

/** Asks worker for metrics, optionally resets. */
export interface SnapshotRequest {
  target: "offscreen";
  snapshot: true;
  reset?: boolean;
}

export interface Snapshot {
  /** Epoch ms of worker start or last reset */
  since: number;
  metrics: Record<string, Summary>;
  /** Current sizes */
  gauges: Record<string, number>;
}
