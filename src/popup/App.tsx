import { useEffect, useState } from "react";
import { flags } from "@/lib/flags";
import { activeTab, hostOf, loadBlocked } from "./data";
import { LogsPanel } from "./LogsPanel";
import { RulesPanel } from "./RulesPanel";
import { SiteCard } from "./SiteCard";

export default function App() {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  // null: not loaded yet, undefined: Chrome won't tell for this tab
  const [blocked, setBlocked] = useState<number | undefined | null>(null);
  // bumped to make every section reload its numbers
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  useEffect(() => {
    activeTab().then(setTab);
  }, []);

  useEffect(() => {
    if (tab) loadBlocked(tab).then(setBlocked);
  }, [tab, tick]);

  let host: string | undefined;
  if (tab) host = hostOf(tab);

  let shown = "…";
  if (blocked === undefined) shown = "–";
  else if (blocked !== null) shown = String(blocked);

  return (
    <main>
      <header>
        <h1>Blocker</h1>
        <small>ML ad &amp; tracker blocking</small>
      </header>

      <section className="count">
        <strong>{shown}</strong>
        <small>blocked on this page</small>
      </section>

      {tab && host && <SiteCard tab={tab} host={host} />}

      <RulesPanel tick={tick} onChange={refresh} />
      {flags.perf.enabled && <LogsPanel tick={tick} onChange={refresh} />}
    </main>
  );
}
