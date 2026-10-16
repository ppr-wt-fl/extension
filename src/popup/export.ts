import { exportOutbox, installId } from "@/lib/perf/outbox";

/** Bytes as MB, or GB once it reaches 1000 MB. */
export function formatSize(bytes: number) {
  const mb = bytes / 1e6;
  if (mb < 1000) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1000).toFixed(2)} GB`;
}

/** Downloads the outbox as gzipped NDJSON files, passing each file's last key to `onSaved` once it is on disk. */
export async function download(onSaved: (lastKey: IDBValidKey) => void) {
  const install = await installId();
  let after: IDBValidKey | undefined;
  while (true) {
    const { blob, lastKey, full } = await exportOutbox(install, after);
    if (lastKey === undefined) return;
    await save(blob, install);
    onSaved(lastKey);
    // records written meanwhile wait for the next export, else a slow save chases new flushes forever
    if (!full) return;
    after = lastKey;
  }
}

/** Downloads `blob`, `install` in its filename, resolves once the file is saved. */
async function save(blob: Blob, install: string) {
  const url = URL.createObjectURL(blob);
  try {
    // chrome.downloads, not <a download>: "clear exported" must only show once the file is really on disk
    const id = await chrome.downloads.download({
      url,
      // ":" is an invalid filename character on Windows, rejected by chrome.downloads
      filename: `perf-${install.slice(0, 8)}-${new Date().toISOString().replace(/:/g, "-")}.ndjson.gz`,
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
}
