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

/** Removes every block rule and cached verdict, in the service worker (src/background). */
async function resetRules() {
  if (confirm('Remove all block rules?')) await chrome.runtime.sendMessage({ resetRules: true })
}

export default function App() {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>()
  const [exported, setExported] = useState<IDBValidKey>()
  const refresh = useCallback(() => load().then(setData), [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const reset = <button onClick={() => resetRules().then(refresh)}>reset rules</button>

  if (!flags.perf.enabled)
    return (
      <main>
        <h1>Blocker</h1>
        {reset}
      </main>
    )

  return (
    <main style={{ font: '12px monospace', minWidth: 320, padding: 8 }}>
      <h1>Blocker</h1>
      <button onClick={refresh}>refresh</button>{' '}
      <button onClick={() => download().then(setExported)}>export</button>{' '}
      {exported !== undefined && (
        <button onClick={() => deleteUpTo(exported).then(() => setExported(undefined)).then(refresh)}>
          clear exported
        </button>
      )}{' '}
      <button onClick={() => clearOutbox().then(refresh)}>clear all</button>{' '}
      {reset}
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
