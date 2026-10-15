import { useCallback, useEffect, useState } from 'react'
import { flags } from '@/lib/flags'
import { clearOutbox, deleteUpTo, exportOutbox, outboxStats } from '@/lib/perf/outbox'

/** Outbox size + rule cap. */
async function load() {
  return {
    ...(await outboxStats()),
    'rules.installed': (await chrome.declarativeNetRequest.getDynamicRules()).length,
    'rules.cap': chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES,
  } as Record<string, number | undefined>
}

/** Downloads the outbox as gzipped NDJSON, returns the last exported key. */
async function download() {
  const { blob, lastKey } = await exportOutbox()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `perf-${new Date().toISOString()}.ndjson.gz`
  a.click()
  URL.revokeObjectURL(a.href)
  return lastKey
}

/** Blocked requests on the active tab since its last page load. */
async function loadBlocked() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) return 'n/a'
  // Chrome keeps the matches of the tab's current document, so navigation, bfcache and prerender are handled
  // rejects when rate limited or activeTab isn't granted (some chrome:// pages)
  const matched = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id }).catch(() => undefined)
  return matched?.rulesMatchedInfo.length ?? 'n/a'
}

export default function App() {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>()
  const [exported, setExported] = useState<IDBValidKey>()
  const [blocked, setBlocked] = useState<number | string>()
  const refresh = useCallback(() => {
    loadBlocked().then(setBlocked)
    if (flags.perf.enabled) load().then(setData)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const header = (
    <>
      <h1>Blocker</h1>
      <p>Blocked on this page: {blocked ?? '…'}</p>
    </>
  )
  if (!flags.perf.enabled) return header

  return (
    <main style={{ font: '12px monospace', minWidth: 320, padding: 8 }}>
      {header}
      <button onClick={refresh}>refresh</button>{' '}
      <button onClick={() => download().then(setExported)}>export</button>{' '}
      {exported !== undefined && (
        <button onClick={() => deleteUpTo(exported).then(() => setExported(undefined)).then(refresh)}>
          clear exported
        </button>
      )}{' '}
      <button onClick={() => clearOutbox().then(refresh)}>clear all</button>
      <table>
        <tbody>
          {Object.entries(data ?? {}).map(([name, value]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
