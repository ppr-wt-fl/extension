import { readFileSync } from 'node:fs'
import { io, memory, setBackend } from '@tensorflow/tfjs'
import '@tensorflow/tfjs-backend-wasm'
import { beforeAll, expect, test } from 'vitest'
import { flags } from '@/flags'
import { loadModel, predict, THRESHOLD } from '@/model'
import { setSink, type Sample } from '@/perf'
import { Learner, Reservoir, type LearnConfig } from '.'

// FIXME: use the copy of the model in this repo once it's there (see src/collect/index.ts)
const dir = new URL(
  '../../../robustness-evaluation/AdFlushAutokeras/source/autokeras/runs/2026-10-01_19-33-34/model/AdFlush_autokeras_tfjs/',
  import.meta.url,
)
const json = JSON.parse(readFileSync(new URL('model.json', dir), 'utf8')) as io.ModelJSON
const weights = readFileSync(new URL('group1-shard1of1.bin', dir))
const validation: { samples: number[][]; expected_predictions: number[] } = JSON.parse(
  readFileSync(new URL('validation_samples.json', dir), 'utf8'),
)
const rows = validation.samples.map((row) => Float64Array.from(row))
/** The opposite of the model's verdict, so training has something to change. */
const flipped = (i: number) => Number(validation.expected_predictions[i] < THRESHOLD) as 0 | 1

beforeAll(async () => {
  await setBackend('wasm')
})

/** A learner on fresh copies of the model, collecting its round updates. */
async function learner(overrides: Partial<LearnConfig> = {}, measureFl = false) {
  const updates: Float32Array[] = []
  const config = { ...flags.learn, batchSize: 1000, idleMs: 1000, roundSteps: 1000, replayFraction: 0, ...overrides }
  const l = new Learner(
    await loadModel(json, weights),
    await loadModel(json, weights),
    config,
    (u) => updates.push(u),
    measureFl,
  )
  return { learner: l, updates }
}

const norm = (u: Float32Array) => Math.sqrt(u.reduce((s, v) => s + v * v, 0))
const maxDiff = (a: Float32Array, b: Float32Array) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0)

/** Submits rows from..from+n-1 with flipped labels, as one batch, and returns the verdicts. */
async function trainOn(l: Learner, n: number, site: (i: number) => string = () => 'a', from = 0) {
  const pending = rows
    .slice(from, from + n)
    .map((row, i) => l.submit({ features: row, label: flipped(from + i), site: site(from + i) }))
  await l.flush()
  return Promise.all(pending)
}

test('classifies like the model before training, with the training pass in either mode', async () => {
  const expected = predict(await loadModel(json, weights), rows.slice(0, 6))
  for (const trainMode of ['inference', 'training'] as const) {
    const { learner: l, updates } = await learner({ trainMode, chunkSize: 4 })
    const probabilities = await trainOn(l, 6)
    probabilities.forEach((p, i) => expect(p).toBeCloseTo(expected[i], 5))
    l.endRound()
    expect(norm(updates[0])).toBeGreaterThan(0)
  }
})

test('without labels the model stays the same', async () => {
  const { learner: l, updates } = await learner()
  const pending = rows.slice(0, 8).map((row) => l.submit({ features: row, site: 'a' }))
  await l.flush()
  await Promise.all(pending)
  l.endRound()
  expect(updates[0].every((v) => v === 0)).toBe(true)
})

test('chunks add up to the same step', async () => {
  const whole = await learner({ chunkSize: 100 })
  const chunked = await learner({ chunkSize: 2 })
  for (const { learner: l } of [whole, chunked]) {
    await trainOn(l, 7)
    l.endRound()
  }
  expect(maxDiff(whole.updates[0], chunked.updates[0]) / norm(whole.updates[0])).toBeLessThan(1e-4)
})

test("clips each site's gradient", async () => {
  // one step: lr / rows * clipped gradient
  const { learner: l, updates } = await learner({ learningRate: 1, siteClip: 0.001 })
  await trainOn(l, 5)
  l.endRound()
  expect(norm(updates[0])).toBeCloseTo(0.001 / 5, 5)

  // two sites, each clipped separately
  const two = await learner({ learningRate: 1, siteClip: 0.001 })
  await trainOn(two.learner, 6, (i) => (i < 3 ? 'a' : 'b'))
  two.learner.endRound()
  expect(norm(two.updates[0])).toBeLessThanOrEqual((2 * 0.001) / 6 + 1e-7)
})

test('sends a clipped update after roundSteps and starts over from global', async () => {
  const { learner: l, updates } = await learner({ roundSteps: 2, updateClip: 0.01, siteClip: 100 })
  await trainOn(l, 4)
  // other rows: identical ones would be skipped as already trained on this round
  await trainOn(l, 4, () => 'b', 4)
  expect(updates).toHaveLength(1)
  expect(norm(updates[0])).toBeCloseTo(0.01, 5)
  l.endRound()
  expect(updates[1].every((v) => v === 0)).toBe(true)
})

test('trains on a row once per round, and at most perSiteLimit per site', async () => {
  const { learner: l, updates } = await learner({ perSiteLimit: 1 })
  // only the first is admitted: the second is the same row from another site, the others hit the site's limit
  const pending = [
    l.submit({ features: rows[0], label: flipped(0), site: 'a' }),
    l.submit({ features: rows[0], label: flipped(0), site: 'b' }),
    l.submit({ features: rows[1], label: flipped(1), site: 'a' }),
    l.submit({ features: rows[2], label: flipped(2), site: 'a' }),
  ]
  await l.flush()
  await Promise.all(pending)
  l.endRound()

  const alone = await learner()
  await trainOn(alone.learner, 1)
  alone.learner.endRound()
  expect(maxDiff(updates[0], alone.updates[0])).toBeLessThan(1e-6)
})

test('frees its tensors, also with the training metrics', async () => {
  for (const measureFl of [false, true]) {
    const { learner: l } = await learner({ roundSteps: 2, chunkSize: 3 }, measureFl)
    await trainOn(l, 6)
    const tensors = memory().numTensors
    await trainOn(l, 6, () => 'b', 6)
    await trainOn(l, 6, () => 'c', 12)
    expect(memory().numTensors).toBe(tensors)
  }
})

test('records the training metrics only with measureFl', async () => {
  const samples: Sample[] = []
  setSink((s) => samples.push(...s))
  const names = async () => {
    await new Promise((r) => setTimeout(r))
    return new Set(samples.splice(0).map(([name]) => name))
  }
  await names()

  for (const measureFl of [false, true]) {
    const { learner: l } = await learner({ roundSteps: 2 }, measureFl)
    await trainOn(l, 4)
    await trainOn(l, 4, () => 'b', 4)
    const fl = [...(await names())].filter((n) => n.startsWith('fl.'))
    if (!measureFl) expect(fl).toEqual([])
    else
      expect(fl).toEqual(
        expect.arrayContaining([
          'fl.loss',
          'fl.siteGradNorm',
          'fl.siteClipped',
          'fl.disagreement',
          'fl.probabilityDiff',
          'fl.updateNorm',
          'fl.updateClipped',
          'fl.roundMs',
          'fl.roundRows',
          'fl.updateBytes',
        ]),
      )
  }
})

test('reservoir keeps at most its capacity and samples distinct items', () => {
  const reservoir = new Reservoir<number>(10)
  for (let i = 0; i < 1000; i++) reservoir.add(i)
  expect(reservoir.items).toHaveLength(10)
  expect(new Set(reservoir.sample(5)).size).toBe(5)
  expect(reservoir.sample(50)).toHaveLength(10)
})
