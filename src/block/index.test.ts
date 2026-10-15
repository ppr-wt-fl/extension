import { afterEach, expect, test, vi } from 'vitest'
import { blockable, installedRules, rule, ruleKey } from '.'

const runtime = { getURL: (path: string) => `chrome-extension://ours/${path}` }
afterEach(() => vi.unstubAllGlobals())

const req = {
  url: 'https://ads.example/a.js?cb=1',
  topLevelUrl: 'https://news.example/article',
  type: 'script',
}

test('installedRules restores the key a rule was made for', async () => {
  vi.stubGlobal('chrome', {
    runtime,
    declarativeNetRequest: {
      RuleActionType: { BLOCK: 'block' },
      getDynamicRules: async () => [rule(7, req)],
    },
  })
  expect(await installedRules()).toEqual([{ id: 7, key: ruleKey(req) }])
})

test('installedRules removes only rules of our own files', async () => {
  const ws = { ...req, url: 'wss://ads.example/socket', type: 'websocket' }
  const other = { ...req, url: 'chrome-extension://other/a.js' }
  const updateDynamicRules = vi.fn(async () => {})
  vi.stubGlobal('chrome', {
    runtime,
    declarativeNetRequest: {
      RuleActionType: { BLOCK: 'block' },
      getDynamicRules: async () => [
        rule(7, req),
        rule(8, { ...req, url: 'chrome-extension://ours/vendor/a.js' }),
        rule(9, ws),
        rule(10, other),
      ],
      updateDynamicRules,
    },
  })
  expect(await installedRules()).toEqual([
    { id: 7, key: ruleKey(req) },
    { id: 9, key: ruleKey(ws) },
    { id: 10, key: ruleKey(other) },
  ])
  expect(updateDynamicRules).toHaveBeenCalledWith({ removeRuleIds: [8] })
})

test('blockable', () => {
  vi.stubGlobal('chrome', { runtime })
  expect(blockable(req)).toBe(true)
  expect(blockable({ ...req, url: 'wss://ads.example/socket', type: 'websocket' })).toBe(true)
  expect(blockable({ ...req, type: 'main_frame' })).toBe(false)
  expect(blockable({ ...req, url: 'chrome-extension://ours/vendor/a.js' })).toBe(false)
  expect(blockable({ ...req, url: 'https://ads.example/ä.js' })).toBe(false)
  expect(blockable({ ...req, url: 'https://ads.example/a|b' })).toBe(false)
})
