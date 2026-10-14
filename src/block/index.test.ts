import { expect, test, vi } from 'vitest'
import { blockable, installedRules, rule, ruleKey } from '.'

const req = {
  url: 'https://ads.example/a.js?cb=1',
  topLevelUrl: 'https://news.example/article',
  type: 'script',
}

test('installedRules restores the key a rule was made for', async () => {
  vi.stubGlobal('chrome', {
    declarativeNetRequest: {
      RuleActionType: { BLOCK: 'block' },
      getDynamicRules: async () => [rule(7, req)],
    },
  })
  expect(await installedRules()).toEqual([{ id: 7, key: ruleKey(req) }])
  vi.unstubAllGlobals()
})

test('blockable', () => {
  expect(blockable(req)).toBe(true)
  expect(blockable({ ...req, type: 'main_frame' })).toBe(false)
  expect(blockable({ ...req, url: 'https://ads.example/ä.js' })).toBe(false)
  expect(blockable({ ...req, url: 'https://ads.example/a|b' })).toBe(false)
})
