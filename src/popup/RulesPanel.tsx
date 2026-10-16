import { useEffect, useState } from "react";
import { loadRules, resetRules } from "./data";
import { ConfirmButton } from "./ConfirmButton";

/** Block rules in use, and a reset. Reloads on `tick`; `onChange` asks the popup to reload everything. */
export function RulesPanel({
  tick,
  onChange,
}: {
  tick: number;
  onChange: () => void;
}) {
  const [rules, setRules] = useState<Awaited<ReturnType<typeof loadRules>>>();

  useEffect(() => {
    loadRules().then(setRules);
  }, [tick]);

  return (
    <section className="panel">
      <hr />
      <h2>Rules</h2>
      {rules && (
        <>
          <dl className="stats">
            <dt>Installed</dt>
            <dd>
              {rules.installed} / {rules.cap}
            </dd>
          </dl>
          <progress value={rules.installed} max={rules.cap} />
        </>
      )}
      <ConfirmButton
        className="secondary outline"
        onConfirm={() => resetRules().then(onChange)}
      >
        Reset rules
      </ConfirmButton>
    </section>
  );
}
