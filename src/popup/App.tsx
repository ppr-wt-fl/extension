import { useCallback, useEffect, useState } from 'react'
import { flags } from '@/flags'
import type { Snapshot, SnapshotRequest } from '@/perf'
import { SESSION_COUNTERS } from '@/perf/session'

/** Worker metrics + session counters + rule cap. */
async function load(reset = false) {
  const request: SnapshotRequest = { target: 'offscreen', snapshot: true, reset }
  let snapshot: Snapshot | undefined
  try {
    snapshot = await chrome.runtime.sendMessage(request)
  } catch {
    // no offscreen doc yet
  }
  const session = await chrome.storage.session.get([...SESSION_COUNTERS])
  const installed = (await chrome.declarativeNetRequest.getDynamicRules()).length
  return {
    snapshot,
    gauges: {
      ...snapshot?.gauges,
      ...session,
      'rules.installed': installed,
      'rules.cap': chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES,
    } as Record<string, number>,
  }
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

export default function App() {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>()
  const refresh = useCallback((reset = false) => load(reset).then(setData), [])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!flags.perf.enabled) return <h1>Blocker</h1>

  return (
    <main style={{ font: '12px monospace', minWidth: 640, padding: 8 }}>
      <h1>Blocker</h1>
      <button onClick={() => refresh()}>refresh</button>{' '}
      <button onClick={() => refresh(true)}>reset</button>
      {data?.snapshot && <p>since {new Date(data.snapshot.since).toLocaleTimeString()}</p>}
      <table>
        <tbody>
          {Object.entries(data?.gauges ?? {}).map(([name, value]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{fmt(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead>
          <tr>
            {['metric', 'count', 'sum', 'mean', 'p50', 'p95', 'p99', 'max'].map((h) => (
              <th key={h} style={{ textAlign: 'left' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(data?.snapshot?.metrics ?? {}).map(([name, s]) => (
            <tr key={name}>
              <td>{name}</td>
              {[s.count, s.sum, s.mean, s.p50, s.p95, s.p99, s.max].map((v, i) => (
                <td key={i}>{fmt(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
