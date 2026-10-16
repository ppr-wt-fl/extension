import { useEffect, useState } from "react";
import { count, type Metric } from "@/lib/perf";
import { ConfirmButton } from "./ConfirmButton";
import { disabledSites, setSiteDisabled, siteDisabled } from "@/lib/block";

/** One-shot report counted as `metric`, remembered per host for the browser session. */
function ReportButton({
  host,
  metric,
  label,
}: {
  host: string;
  metric: Metric;
  label: string;
}) {
  const [reported, setReported] = useState(false);
  const [reportedBefore, setReportedBefore] = useState(false);
  const reportKey = `${metric}:${host}`;

  useEffect(() => {
    chrome.storage.session
      .get(reportKey)
      .then((stored) => setReportedBefore(!!stored[reportKey]));
  }, [reportKey]);

  if (reported) {
    return (
      <button className="secondary outline" disabled>
        Reported, thank you
      </button>
    );
  }

  let shown = label;
  if (reportedBefore) shown = "Already reported. Report again";

  return (
    <ConfirmButton
      className="secondary outline"
      onConfirm={() => {
        count(metric);
        chrome.storage.session.set({ [reportKey]: true });
        setReported(true);
      }}
    >
      {shown}
    </ConfirmButton>
  );
}

/** Blocking switch for the tab's site, plus breakage and ad/tracker reports. */
export function SiteCard({
  tab,
  host,
}: {
  tab: chrome.tabs.Tab;
  host: string;
}) {
  const [disabled, setDisabled] = useState<boolean>();
  const [changed, setChanged] = useState(false);

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
      <ReportButton
        host={host}
        metric="block.breakageReported"
        label="Report broken site"
      />
      <ReportButton
        host={host}
        metric="block.adSeenReported"
        label="Report seeing an ad/tracker"
      />
    </article>
  );
}
