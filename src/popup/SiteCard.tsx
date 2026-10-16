import { useEffect, useState } from "react";
import { count } from "@/lib/perf";
import { ConfirmButton } from "./ConfirmButton";
import { disabledSites, setSiteDisabled, siteDisabled } from "@/lib/block";

/** Blocking switch for the tab's site, plus a breakage report. */
export function SiteCard({ tab, host }: { tab: chrome.tabs.Tab; host: string }) {
  const [disabled, setDisabled] = useState<boolean>();
  const [changed, setChanged] = useState(false);
  const [reported, setReported] = useState(false);
  const [reportedBefore, setReportedBefore] = useState(false);
  const reportKey = `reported:${host}`;

  useEffect(() => {
    disabledSites().then((sites) => setDisabled(siteDisabled(sites, host)));
    chrome.storage.session
      .get(reportKey)
      .then((stored) => setReportedBefore(!!stored[reportKey]));
  }, [host]);

  if (disabled === undefined) return null;

  let status = "Blocking ads and trackers";
  if (disabled) status = "Paused on this site";

  const report = () => {
    count("block.breakageReported");
    chrome.storage.session.set({ [reportKey]: true });
    setReported(true);
  };

  let reportLabel = "Report broken site";
  if (reportedBefore) reportLabel = "Already reported. Report again";

  let reportButton = (
    <ConfirmButton className="secondary outline" onConfirm={report}>
      {reportLabel}
    </ConfirmButton>
  );
  if (reported) {
    reportButton = (
      <button className="secondary outline" disabled>
        Reported, thank you
      </button>
    );
  }

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
      {reportButton}
    </article>
  );
}
