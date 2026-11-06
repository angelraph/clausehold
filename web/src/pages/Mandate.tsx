import { useEffect, useState } from "react";
import { ApiDown, PageHead } from "../components/Page";
import { api, ApiError, loadSettings, type MandateView } from "../lib/api";

export default function Mandate() {
  const [m, setM] = useState<MandateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .mandate(loadSettings().mandateId)
      .then(setM)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  return (
    <>
      <PageHead eyebrow="The mandate" title="The treasury's rule, set once." soft="Every clause fits it, or is refused before anyone signs." />
      <div className="wrap grid-2" style={{ paddingBottom: 96, alignItems: "start" }}>
        <div className="card card-pad">
          {error && <ApiDown message={`${error}.`} />}
          {m && (
            <>
              <div className="eyebrow">Set by {m.owner}</div>
              <p style={{ fontSize: 17, marginTop: 14 }}>"{m.naturalLanguageSource}"</p>
              <div className="mini" style={{ marginTop: 16 }}>
                {[
                  ["Assets", m.limits.allowedAssets.join(", ")],
                  ["Max per clause", m.limits.maxPerClause],
                  ["Second person above", m.limits.confirmAbove],
                  ["Per payee per day", m.limits.perPayeeDailyCap],
                  ["All payees per day", m.limits.dailySpendCap],
                  ["New payee ceiling", m.limits.newPayeeCeiling],
                  ["Longest a clause stays open", m.limits.maxDeadlineMinutes ? `${Math.round(m.limits.maxDeadlineMinutes / 1440)} days` : "No limit"],
                ].map(([k, v]) => (
                  <div className="mini-row" key={String(k)}><span className="faint">{k}</span><span className="mono">{String(v)}</span></div>
                ))}
              </div>
              <p className="faint" style={{ fontSize: 13, marginTop: 12 }}>Governs {m.factoryAccountId}. Version {m.version}, {m.status}.</p>
            </>
          )}
        </div>
        <div className="card card-pad">
          <h2 className="h3">Why set it once</h2>
          <p className="muted" style={{ fontSize: 15 }}>
            A DAO should not vote on a 2 dollar invoice. It votes on the rule, in one Sputnik DAO proposal that calls the factory's set_mandate. After that, clauses inside the rule go out without a vote, clauses outside it are refused, and large ones wait for a second person.
          </p>
          <p className="muted" style={{ fontSize: 15 }}>
            The same rule is checked twice: by the desk, so the refusal can name the rule before a wallet prompt, and by the factory contract on chain, which is the check that counts.
          </p>
        </div>
      </div>
    </>
  );
}
