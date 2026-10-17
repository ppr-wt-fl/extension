import { useEffect, useState } from "react";
import { clearOutbox, deleteUpTo } from "@/lib/perf/outbox";
import { loadOutbox } from "./data";
import { download } from "./export";
import { ConfirmButton } from "./ConfirmButton";

/** The perf sample outbox: its size, export and clearing. Reloads on `tick`; `onChange` asks the popup to reload everything. */
export function LogsPanel({
  tick,
  onChange,
}: {
  tick: number;
  onChange: () => void;
}) {
  const [outbox, setOutbox] =
    useState<Awaited<ReturnType<typeof loadOutbox>>>();
  const [exported, setExported] = useState<IDBValidKey>();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    loadOutbox().then(setOutbox);
  }, [tick]);

  return (
    <section className="panel">
      <hr />
      <h2>Logs</h2>
      {outbox && (
        <dl className="stats">
          <dt>Samples</dt>
          <dd>{outbox.records}</dd>
          <dt>Samples' size</dt>
          <dd>{outbox.size ?? "n/a"}</dd>
        </dl>
      )}

      <div role="group">
        <button
          disabled={downloading}
          aria-busy={downloading}
          onClick={() => {
            setDownloading(true);
            setError(undefined);
            // keys of saved files are kept on failure, so "clear exported" still deletes only those
            download(setExported)
              .catch((e) => setError(`Export failed: ${e}`))
              .finally(() => setDownloading(false));
          }}
        >
          Export
        </button>
        {exported !== undefined && (
          <ConfirmButton
            className="secondary"
            onConfirm={() =>
              deleteUpTo(exported)
                .then(() => setExported(undefined))
                .then(onChange)
            }
          >
            Clear exported
          </ConfirmButton>
        )}
        <ConfirmButton
          className="secondary"
          onConfirm={() =>
            clearOutbox()
              .then(() => setExported(undefined))
              .then(onChange)
          }
        >
          Clear all
        </ConfirmButton>
        <button className="secondary outline" onClick={onChange}>
          Refresh
        </button>
      </div>
      {/* a popup closes on blur (Save As dialog, a click outside), killing a long export */}
      {downloading && <small>Keep this open until the download is done.</small>}
      {error && <small className="error">{error}</small>}
    </section>
  );
}
