import { readFileSync } from "node:fs";
import { io, memory, setBackend } from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-wasm";
import { beforeAll, expect, test, vi } from "vitest";
import { flags } from "@/lib/flags";
import { loadModel, predict, THRESHOLD, transposeFreeMatMul } from "@/model";
import { initSink, type Sample } from "@/lib/perf";
import { Classifier, Reservoir, Trainer, type LearnConfig } from ".";

// initSink writes to the outbox (IndexedDB); collect the samples here instead
const samples = vi.hoisted((): Sample[] => []);
vi.mock("@/lib/perf/outbox", () => ({
  outboxSink: () => (s: Sample[]) => samples.push(...s),
}));

const dir = new URL("../../model/adflush/", import.meta.url);
const json = JSON.parse(
  readFileSync(new URL("model.json", dir), "utf8"),
) as io.ModelJSON;
const weights = readFileSync(new URL("group1-shard1of1.bin", dir));
const validation: { samples: number[][]; expected_predictions: number[] } =
  JSON.parse(readFileSync(new URL("validation_samples.json", dir), "utf8"));
const rows = validation.samples.map((row) => Float64Array.from(row));
/** The opposite of the model's verdict, so training has something to change. */
const flipped = (i: number) =>
  Number(validation.expected_predictions[i] < THRESHOLD) as 0 | 1;

beforeAll(async () => {
  await setBackend("wasm");
  transposeFreeMatMul();
  initSink("test", 0);
});

/** A classifier and trainer on fresh copies of the model, collecting the round updates. */
async function learner(
  overrides: Partial<LearnConfig> = {},
  measureFl = false,
) {
  const updates: Float32Array[] = [];
  const config = {
    ...flags.learn,
    batchSize: 1000,
    idleMs: 1000,
    roundSteps: 1000,
    replayFraction: 0,
    ...overrides,
  };
  const global = await loadModel(json, weights);
  const local = await loadModel(json, weights);
  const trainer = new Trainer(
    global,
    local,
    config,
    () => classifier.flush(),
    (u) => updates.push(u),
    measureFl,
  );
  const classifier = new Classifier(global, local, trainer, config, measureFl);
  return { classifier, trainer, config, updates };
}
type Learner = Awaited<ReturnType<typeof learner>>;

const norm = (u: Float32Array) => Math.sqrt(u.reduce((s, v) => s + v * v, 0));
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Array.from(a).reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/** Adds rows from..from+n-1 with flipped labels, as one step. */
async function trainOn(
  l: Learner,
  n: number,
  site: (i: number) => string = () => "a",
  from = 0,
) {
  l.config.miniBatchSize = n;
  const steps = rows.slice(from, from + n).map((row, i) =>
    l.trainer.add({
      features: row,
      label: flipped(from + i),
      site: site(from + i),
    }),
  );
  await Promise.all(steps);
}

/** Verdicts on the first n rows. */
function classify(l: Learner, n = 6) {
  const pending = rows.slice(0, n).map((row) => l.classifier.submit(row));
  l.classifier.flush();
  return Promise.all(pending);
}

test("classifies with the local or the global weights", async () => {
  const expected = predict(await loadModel(json, weights), rows.slice(0, 6));
  for (const inferWith of ["local", "global"] as const) {
    const l = await learner({ inferWith, learningRate: 1, siteClip: 100 });
    expect(maxDiff(await classify(l), expected)).toBeLessThan(1e-5);
    await trainOn(l, 6);
    const moved = maxDiff(await classify(l), expected) > 1e-4;
    expect(moved).toBe(inferWith === "local");
  }
});

test("trains in either mode", async () => {
  for (const trainMode of ["inference", "training"] as const) {
    const l = await learner({ trainMode });
    await trainOn(l, 6);
    l.trainer.endRound();
    expect(norm(l.updates[0])).toBeGreaterThan(0);
  }
});

test("classifying leaves the model the same", async () => {
  const l = await learner();
  await classify(l, 8);
  l.trainer.endRound();
  expect(l.updates[0].every((v) => v === 0)).toBe(true);
});

test("slices add up to the same step", async () => {
  const whole = await learner({ sliceRows: 100 });
  const sliced = await learner({ sliceRows: 2 });
  for (const l of [whole, sliced]) {
    await trainOn(l, 7);
    l.trainer.endRound();
  }
  expect(
    maxDiff(whole.updates[0], sliced.updates[0]) / norm(whole.updates[0]),
  ).toBeLessThan(1e-4);
});

test("steps on every miniBatchSize rows, and keeps the rest buffered", async () => {
  const l = await learner({ miniBatchSize: 3 });
  const add = (i: number) =>
    l.trainer.add({ features: rows[i], label: flipped(i), site: "a" });
  await add(0);
  await add(1);
  expect(l.trainer.sizes()).toMatchObject({ buffer: 2, steps: 0 });
  await add(2);
  expect(l.trainer.sizes()).toMatchObject({ buffer: 0, steps: 1 });
  await add(3);
  expect(l.trainer.sizes()).toMatchObject({ buffer: 1, steps: 1 });
});

test("classifies a request that arrives during a step before the step ends", async () => {
  const l = await learner({ miniBatchSize: 4, sliceRows: 1 });
  const step = trainOn(l, 4);
  // the step is past its first slice
  await new Promise((r) => setTimeout(r));
  const stepsAtVerdict = l.classifier
    .submit(rows[10])
    .then(() => l.trainer.steps);
  expect(await stepsAtVerdict).toBe(0);
  await step;
  expect(l.trainer.steps).toBe(1);
});

test("clips each site's gradient", async () => {
  // one step: lr / rows * clipped gradient
  const l = await learner({ learningRate: 1, siteClip: 0.001 });
  await trainOn(l, 5);
  l.trainer.endRound();
  expect(norm(l.updates[0])).toBeCloseTo(0.001 / 5, 5);

  // two sites, each clipped separately
  const two = await learner({ learningRate: 1, siteClip: 0.001 });
  await trainOn(two, 6, (i) => (i < 3 ? "a" : "b"));
  two.trainer.endRound();
  expect(norm(two.updates[0])).toBeLessThanOrEqual((2 * 0.001) / 6 + 1e-7);
});

test("without siteClip, trains on every site's rows together, unclipped", async () => {
  const update = async (siteClip: number | undefined) => {
    const l = await learner({ learningRate: 1, siteClip, sliceRows: 2 });
    await trainOn(l, 6, (i) => (i < 3 ? "a" : "b"));
    l.trainer.endRound();
    return l.updates[0];
  };
  expect(maxDiff(await update(undefined), await update(1e9))).toBeLessThan(
    1e-5,
  );
});

test("sends a clipped update after roundSteps and starts over from global", async () => {
  const l = await learner({ roundSteps: 2, updateClip: 0.01, siteClip: 100 });
  await trainOn(l, 4);
  // other rows: identical ones would be skipped as already trained on this round
  await trainOn(l, 4, () => "b", 4);
  expect(l.updates).toHaveLength(1);
  expect(norm(l.updates[0])).toBeCloseTo(0.01, 5);
  l.trainer.endRound();
  expect(l.updates[1].every((v) => v === 0)).toBe(true);
});

test("epochs train on the round's rows again before sending", async () => {
  const update = async (epochs: number) => {
    const l = await learner({
      epochs,
      roundSteps: 1,
      learningRate: 1e-4,
      siteClip: 100,
      updateClip: 100,
    });
    await trainOn(l, 4);
    expect(l.updates).toHaveLength(1);
    return l.updates[0];
  };
  // a small step barely changes the gradient, so a second epoch about doubles the update
  expect(norm(await update(2)) / norm(await update(1))).toBeCloseTo(2, 1);
});

test("trains on a row once per round, and at most perSiteLimit per site", async () => {
  const l = await learner({ perSiteLimit: 1, miniBatchSize: 1 });
  // only the first is admitted: the second is the same row from another site, the others hit the site's limit
  await Promise.all([
    l.trainer.add({ features: rows[0], label: flipped(0), site: "a" }),
    l.trainer.add({ features: rows[0], label: flipped(0), site: "b" }),
    l.trainer.add({ features: rows[1], label: flipped(1), site: "a" }),
    l.trainer.add({ features: rows[2], label: flipped(2), site: "a" }),
  ]);
  l.trainer.endRound();

  const alone = await learner();
  await trainOn(alone, 1);
  alone.trainer.endRound();
  expect(maxDiff(l.updates[0], alone.updates[0])).toBeLessThan(1e-6);
});

test("frees its tensors, also with the training metrics", async () => {
  for (const measureFl of [false, true]) {
    const l = await learner({ roundSteps: 2, sliceRows: 3 }, measureFl);
    await trainOn(l, 6);
    await classify(l);
    const tensors = memory().numTensors;
    await trainOn(l, 6, () => "b", 6);
    await classify(l);
    await trainOn(l, 6, () => "c", 12);
    await classify(l);
    expect(memory().numTensors).toBe(tensors);
  }
});

test("frees the summed gradients when a step fails", async () => {
  const l = await learner({ sliceRows: 2 });
  await trainOn(l, 4);
  const tensors = memory().numTensors;
  // fails before the second slice, with the first one's gradients summed
  let slices = 0;
  vi.spyOn(l.classifier, "flush").mockImplementation(() => {
    if (++slices === 2) throw new Error("test");
  });
  await trainOn(l, 4, () => "a", 4);
  expect(slices).toBe(2);
  expect(memory().numTensors).toBe(tensors);
});

test("records the training metrics only with measureFl", async () => {
  const names = async () => {
    await new Promise((r) => setTimeout(r));
    return new Set(samples.splice(0).map(([name]) => name));
  };
  await names();

  for (const measureFl of [false, true]) {
    const l = await learner({ roundSteps: 2 }, measureFl);
    await trainOn(l, 4);
    await classify(l);
    await trainOn(l, 4, () => "b", 4);
    const fl = [...(await names())].filter((n) => n.startsWith("fl."));
    if (!measureFl) expect(fl).toEqual([]);
    else
      expect(fl).toEqual(
        expect.arrayContaining([
          "fl.loss",
          "fl.siteGradNorm",
          "fl.siteClipped",
          "fl.disagreement",
          "fl.probabilityDiff",
          "fl.updateNorm",
          "fl.updateClipped",
          "fl.roundMs",
          "fl.roundRows",
          "fl.updateBytes",
        ]),
      );
  }
});

test("reservoir keeps at most its capacity and samples distinct items", () => {
  const reservoir = new Reservoir<number>(10);
  for (let i = 0; i < 1000; i++) reservoir.add(i);
  expect(reservoir.items).toHaveLength(10);
  expect(new Set(reservoir.sample(5)).size).toBe(5);
  expect(reservoir.sample(50)).toHaveLength(10);
});
