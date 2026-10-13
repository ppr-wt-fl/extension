import { expect, test } from 'vitest'
import { flags } from '@/flags'
import { Metrics } from '.'

test('summarizes samples by name', () => {
  const metrics = new Metrics()
  metrics.add(Array.from({ length: 100 }, (_, i) => ['a', i + 1] as [string, number]))
  metrics.add([['b', 1], ['b', NaN]])
  const { a, b } = metrics.summary()
  expect(a).toMatchObject({ count: 100, sum: 5050, min: 1, max: 100, last: 100, mean: 50.5, p50: 51, p95: 96, p99: 100 })
  // non-finite samples are dropped
  expect(b.count).toBe(1)
  metrics.reset()
  expect(metrics.summary()).toEqual({})
})

test('percentiles cover the last window of samples, the totals all of them', () => {
  const metrics = new Metrics()
  const n = flags.perf.window
  metrics.add(Array.from({ length: n }, () => ['a', 1000] as [string, number]))
  metrics.add(Array.from({ length: n }, () => ['a', 1] as [string, number]))
  const { a } = metrics.summary()
  expect(a.count).toBe(2 * n)
  expect(a.max).toBe(1000)
  expect(a.p99).toBe(1)
})
