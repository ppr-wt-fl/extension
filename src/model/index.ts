import {
  dispose,
  io,
  loadLayersModel,
  losses,
  randomNormal,
  Reduction,
  tensor2d,
  tidy,
  variableGrads,
  type LayersModel,
  type Scalar,
  type Tensor,
  type Tensor2D,
  type Variable,
} from "@tensorflow/tfjs";

/** Probability at or above which a request is blocked. */
export const THRESHOLD = 0.5;

/**
 * Loads a tfjs Layers model from its model.json and weight shard. Any architecture works, as long as it maps
 * feature vectors [n, features] to block probabilities [n, 1].
 */
export function loadModel(
  json: io.ModelJSON,
  weights: ArrayBuffer | ArrayBufferView,
): Promise<LayersModel> {
  const data = ArrayBuffer.isView(weights)
    ? weights.buffer.slice(
        weights.byteOffset,
        weights.byteOffset + weights.byteLength,
      )
    : weights;

  return loadLayersModel(
    io.fromMemory({
      modelTopology: json.modelTopology,
      weightSpecs: json.weightsManifest.flatMap((group) => group.weights),
      weightData: data as ArrayBuffer,
    }),
  );
}

export function inputSize(model: LayersModel) {
  return model.inputs[0].shape[1]!;
}

function makeBatchTensor(rows: readonly Float64Array[], n: number): Tensor2D {
  const input = new Float32Array(rows.length * n);

  rows.forEach((row, i) => {
    if (row.length !== n)
      throw new Error(`expected ${n} features, got ${row.length}`);
    input.set(row, i * n);
  });

  return tensor2d(input, [rows.length, n]);
}

/** Block probability of each feature vector. */
export function predict(
  model: LayersModel,
  rows: readonly Float64Array[],
): Float32Array {
  return tidy(() => {
    const batch = makeBatchTensor(rows, inputSize(model));
    const prediction = model.predict(batch) as Tensor;
    return prediction.dataSync() as Float32Array;
  });
}

/**
 * - modeDependent: the model computes something else in training mode (Dropout, BatchNorm, noise layers), found by
 *   comparing two training-mode passes and an inference-mode pass on random input
 * - stateful: it has non-trainable weights, e.g. BatchNorm statistics, which FedAvg updates leave out
 */
export function inspectModes(model: LayersModel): {
  modeDependent: boolean;
  stateful: boolean;
} {
  // a training-mode pass can update BatchNorm statistics
  const state = model.nonTrainableWeights.map((w) => w.read().clone());
  const modeDependent = tidy(() => {
    const x = randomNormal([16, inputSize(model)]);
    const [a, b, c] = [true, true, false].map(
      (training) => model.apply(x, { training }) as Tensor,
    );
    return !(a.equal(b).all().dataSync()[0] && a.equal(c).all().dataSync()[0]);
  });
  model.nonTrainableWeights.forEach((w, i) => w.write(state[i]));
  dispose(state);
  return { modeDependent, stateful: model.nonTrainableWeights.length > 0 };
}

/**
 * Gradient of the summed binary cross-entropy of the rows, one tensor per trainable weight, and the probabilities
 * of the same forward pass. `loss` only with `readLoss`.
 */
export function gradient(
  model: LayersModel,
  rows: readonly Float64Array[],
  labels: readonly number[],
  training: boolean,
  readLoss = false,
): { grads: Tensor[]; probabilities: Float32Array; loss: number } {
  const trainableVariables = model.trainableWeights.map(
    (w) => w.read() as Variable,
  );
  let probabilities: Float32Array = new Float32Array();
  let loss = NaN;

  const grads = tidy(() => {
    const { value, grads } = variableGrads(() => {
      const batch = makeBatchTensor(rows, inputSize(model));
      const output = model.apply(batch, {
        training,
      }) as Tensor;
      probabilities = output.dataSync() as Float32Array;

      return losses.logLoss(
        tensor2d([...labels], [labels.length, 1]),
        output,
        undefined,
        1e-7,
        Reduction.SUM,
      ) as Scalar;
    }, trainableVariables);

    if (readLoss) loss = value.dataSync()[0];
    value.dispose();
    return trainableVariables.map((v) => grads[v.name]);
  });

  return { grads, probabilities, loss };
}
