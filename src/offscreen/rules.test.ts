import { expect, test } from 'vitest'
import type { Source } from '@/collect'
import { flags } from '@/flags'
import { decide, MAX_RULES, restoreRules, ruleChange, rules } from './rules'

test.each([
  // [reconcile, verdicts by source, block]
  ['canonical', [['webRequest', true], ['refetch', false]], false],
  ['canonical', [['dom', false], ['debugger', true], ['captured_by_patch', false]], true],
  ['any', [['webRequest', false], ['refetch', true]], true],
  ['any', [['webRequest', false], ['dom', false]], false],
] as const)('%s %j -> %s', (reconcile, verdicts, block) => {
  flags.reconcile = reconcile
  expect(decide(new Map(verdicts as unknown as [Source, boolean][]))).toBe(block)
  flags.reconcile = 'canonical'
})

test('ruleChange adds once, removes once, evicts the oldest past the limit', () => {
  const first = ruleChange('a', true)!
  expect(first.action).toBe('add')
  expect(ruleChange('a', true)).toBeUndefined()
  expect(ruleChange('a', false)).toEqual({ action: 'remove', id: first.id })
  expect(ruleChange('a', false)).toBeUndefined()

  for (let i = 0; i < MAX_RULES; i++) ruleChange(`k${i}`, true)
  const oldest = rules.get('k0')
  const change = ruleChange('new', true)!
  expect(change.evict).toBe(oldest)
  expect(rules.has('k0')).toBe(false)
  expect(rules.size).toBe(MAX_RULES)
})

test('restoreRules replaces the map, ids never go backwards', () => {
  restoreRules([{ key: 'x', id: 7 }])
  restoreRules([{ key: 'y', id: 3 }])
  expect([...rules]).toEqual([['y', 3]])
  expect(ruleChange('z', true)!.id).toBeGreaterThan(7)
})
