import { readFileSync } from "node:fs";
import { io, layers, sequential, setBackend } from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-wasm";
import { beforeAll, expect, test } from "vitest";
import { presets } from "../features";
import { inspectModes, loadModel, predict, THRESHOLD } from ".";

console.warn(`Using a decission threshold of ${THRESHOLD}`);

// FIXME: use the copy of the model in this repo once it's there (see src/collect/index.ts)
const dir = new URL(
  "../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/",
  import.meta.url,
);

/** Rows of the validation set with the predictions of the Keras model, exported by train_autokeras.py. */
const validation: {
  feature_order: string[];
  samples: number[][];
  labels: number[];
  expected_predictions: number[];
} = JSON.parse(readFileSync(new URL("validation_samples.json", dir), "utf8"));

const rows = validation.samples.map((row) => Float64Array.from(row));

const adflush = () =>
  loadModel(
    JSON.parse(
      readFileSync(new URL("model.json", dir), "utf8"),
    ) as io.ModelJSON,
    readFileSync(new URL("group1-shard1of1.bin", dir)),
  );

beforeAll(async () => {
  await setBackend("wasm");
});

test("feature order matches the preset", () => {
  const renamed = { keyword_char_present: "keyword_raw_present" } as Record<
    string,
    string
  >;
  expect(validation.feature_order.map((name) => renamed[name] ?? name)).toEqual(
    presets.adflush,
  );
});

test("predictions match the Keras model", async () => {
  const predictions = predict(await adflush(), rows);
  expect(predictions.length).toBe(rows.length);
  predictions.forEach((p, i) =>
    expect(p, `sample ${i}`).toBeCloseTo(validation.expected_predictions[i], 5),
  );
});

test("accuracy on the validation samples", async () => {
  const predictions = predict(await adflush(), rows);
  const correct = validation.labels.filter(
    (label, i) => Number(predictions[i] >= THRESHOLD) === label,
  ).length;
  expect(correct / rows.length).toBeGreaterThan(0.9);
});

test("rejects vectors of the wrong length", async () => {
  const model = await adflush();
  expect(() => predict(model, [new Float64Array(3)])).toThrow(
    "expected 27 features, got 3",
  );
});

test("inspectModes finds layers that act differently in training", async () => {
  expect(inspectModes(await adflush())).toEqual({
    modeDependent: true,
    stateful: false,
  });

  const dense = sequential({
    layers: [
      layers.dense({ inputShape: [4], units: 3, activation: "relu" }),
      layers.dense({ units: 1, activation: "sigmoid" }),
    ],
  });
  expect(inspectModes(dense)).toEqual({
    modeDependent: false,
    stateful: false,
  });

  const normalized = sequential({
    layers: [
      layers.dense({ inputShape: [4], units: 3 }),
      layers.batchNormalization(),
      layers.dense({ units: 1, activation: "sigmoid" }),
    ],
  });
  const before = normalized.nonTrainableWeights.map((w) =>
    w.read().dataSync().slice(),
  );
  expect(inspectModes(normalized)).toEqual({
    modeDependent: true,
    stateful: true,
  });
  // the training-mode probe must not change the BatchNorm statistics
  normalized.nonTrainableWeights.forEach((w, i) =>
    expect([...w.read().dataSync()]).toEqual([...before[i]]),
  );
});
