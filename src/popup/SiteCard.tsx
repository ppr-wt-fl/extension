import { useEffect, useState } from "react";
import { count } from "@/lib/perf";
import { disabledSites, setSiteDisabled, siteDisabled } from "@/lib/block";

/** Blocking switch for the tab's site, plus a breakage report. */
export function SiteCard({ tab, host }: { tab: chrome.tabs.Tab; host: string }) {
  const [disabled, setDisabled] = useState<boolean>();
  const [changed, setChanged] = useState(false);
  const [reported, setReported] = useState(false);

  useEffect(() => {
    disabledSites().then((sites) => setDisabled(siteDisabled(sites, host)));
  }, [host]);

  if (disabled === undefined) return null;

  let status = "Blocking ads and trackers";
  if (disabled) status = "Paused on this site";

  return (
    <article className="site">
      <label className="site-toggle">
        <span>
          <strong>{host}</strong>
          <small>{status}</small>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={!disabled}
          onChange={async () => {
            await setSiteDisabled(host, !disabled);
            setDisabled(!disabled);
            setChanged(true);
          }}
        />
      </label>
      {changed && (
        <button
          onClick={() => {
            chrome.tabs.reload(tab.id!);
            window.close();
          }}
        >
          Reload page to apply
        </button>
      )}
      <button
        className="secondary outline"
        disabled={reported}
        onClick={() => {
          count("block.breakageReported");
          setReported(true);
        }}
      >
        {reported && "Reported, thank you"}
        {!reported && "Report broken site"}
      </button>
    </article>
  );
}
