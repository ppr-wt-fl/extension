import { useCallback, useEffect, useState } from "react";
import { flags } from "@/lib/flags";
import { count } from "@/lib/perf";
import { disabledSites, setSiteDisabled, siteDisabled } from "@/lib/block";
import {
  clearOutbox,
  deleteUpTo,
  exportOutbox,
  outboxStats,
} from "@/lib/perf/outbox";

/** Outbox size + rule cap. */
async function load() {
  const stats = await outboxStats();
  return {
    records: stats.records,
    size: stats.bytes === undefined ? undefined : formatSize(stats.bytes),
    "rules.installed": (await chrome.declarativeNetRequest.getDynamicRules())
      .length,
    "rules.cap": chrome.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES,
  };
}

/** Bytes as MB, or GB once it reaches 1000 MB. */
function formatSize(bytes: number) {
  const mb = bytes / 1e6;
  return mb < 1000 ? `${mb.toFixed(1)} MB` : `${(mb / 1000).toFixed(2)} GB`;
}

/** Downloads the outbox as gzipped NDJSON, returns the last exported key once the file is saved. */
async function download() {
  const { blob, lastKey } = await exportOutbox();
  const url = URL.createObjectURL(blob);
  try {
    // chrome.downloads, not <a download>: "clear exported" must only show once the file is really on disk
    const id = await chrome.downloads.download({
      url,
      // ":" is an invalid filename character on Windows, rejected by chrome.downloads
      filename: `perf-${new Date().toISOString().replace(/:/g, "-")}.ndjson.gz`,
    });
    await new Promise<void>((resolve, reject) => {
      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== id || !delta.state) return;
        chrome.downloads.onChanged.removeListener(onChanged);
        if (delta.state.current === "complete") resolve();
        else reject(new Error(`download ${delta.error?.current}`));
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return lastKey;
}

/** Turns blocking on the active tab's site off or on, then reloads the tab so it applies. */
function SiteToggle() {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [disabledStatus, setDisabledStatus] = useState<boolean>();
  // http(s) pages only: other schemes have no hostname or can't be blocked on anyway
  const host =
    tab?.url && /^https?:/.test(tab.url)
      ? new URL(tab.url).hostname
      : undefined;

  useEffect(() => {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([t]) => setTab(t));
  }, []);

  useEffect(() => {
    if (!host) return;

    disabledSites().then((sites) => {
      const isHostDisabled = siteDisabled(sites, host);
      setDisabledStatus(isHostDisabled);
    });
  }, [host]);

  if (!host || disabledStatus === undefined) return null;
  return (
    <p>
      {host}: blocking {disabledStatus ? "off" : "on"}{" "}
      <button
        onClick={async () => {
          await setSiteDisabled(host, !disabledStatus);
          setDisabledStatus(!disabledStatus);
          chrome.tabs.reload(tab!.id!);
        }}
      >
        turn {disabledStatus ? "on" : "off"}
      </button>{" "}
      <button
        onClick={() => {
          if (confirm("Report this site as broken?"))
            count("block.breakageReported");
        }}
      >
        report breakage
      </button>
    </p>
  );
}

/** Removes every block rule and cached verdict, in the service worker (src/background). */
async function resetRules() {
  if (confirm("Remove all block rules?"))
    await chrome.runtime.sendMessage({ resetRules: true });
}

/** Blocked requests on the active tab since its last page load. */
async function loadBlocked() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return "n/a";
  // Chrome keeps the matches of the tab's current document, so navigation, bfcache and prerender are handled
  // rejects when rate limited or activeTab isn't granted (some chrome:// pages)
  const matched = await chrome.declarativeNetRequest
    .getMatchedRules({ tabId: tab.id })
    .catch(() => undefined);
  return matched?.rulesMatchedInfo.length ?? "n/a";
}

export default function App() {
  const [data, setData] = useState<Awaited<ReturnType<typeof load>>>();
  const [exported, setExported] = useState<IDBValidKey>();
  const [downloading, setDownloading] = useState(false);
  const [blocked, setBlocked] = useState<number | string>();
  const refresh = useCallback(() => {
    loadBlocked().then(setBlocked);
    if (flags.perf.enabled) load().then(setData);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const reset = (
    <button onClick={() => resetRules().then(refresh)}>reset rules</button>
  );
  const header = (
    <>
      <h1>Blocker</h1>
      <p>Blocked on this page: {blocked ?? "…"}</p>
      <SiteToggle />
    </>
  );

  if (!flags.perf.enabled)
    return (
      <main>
        {header}
        {reset}
      </main>
    );

  return (
    <main style={{ font: "12px monospace", minWidth: 320, padding: 8 }}>
      {header}
      <button onClick={refresh}>refresh</button>{" "}
      {/* a popup closes on blur (Save As dialog, a click outside), killing a long export; a tab doesn't */}
      <button onClick={() => chrome.tabs.create({ url: location.href })}>
        open in tab
      </button>{" "}
      <button
        disabled={downloading}
        onClick={() => {
          setDownloading(true);
          download()
            .then(setExported)
            .catch((error) => alert(`Export failed: ${error}`))
            .finally(() => setDownloading(false));
        }}
      >
        export
      </button>{" "}
      {exported !== undefined && (
        <button
          onClick={() => {
            if (confirm("Delete the exported samples?"))
              deleteUpTo(exported)
                .then(() => setExported(undefined))
                .then(refresh);
          }}
        >
          clear exported
        </button>
      )}{" "}
      <button
        onClick={() => {
          if (confirm("Delete all samples, including unexported ones?"))
            clearOutbox().then(refresh);
        }}
      >
        clear all
      </button>{" "}
      {reset}
      {downloading && (
        <p>
          <b>Keep this open until the download is done.</b>
        </p>
      )}
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
  );
}
