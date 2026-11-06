import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiDown, PageHead, shortDate, timeLeft } from "../components/Page";
import { StatusChip } from "../components/Status";
import { api, ApiError, loadSettings, saveSettings, statusOf, type DeskClause, type DeskSettings } from "../lib/api";

function Settings({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<DeskSettings>(loadSettings());
  const set = (k: keyof DeskSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value });
  return (
    <form
      className="card card-pad"
      onSubmit={(e) => {
        e.preventDefault();
        saveSettings(s);
        onSaved();
      }}
    >
      <h2 className="h3">Desk settings</h2>
      <p className="muted" style={{ fontSize: 14 }}>Stored in this browser only. The agent key is never sent anywhere but your own desk API.</p>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="field"><label htmlFor="apiBase">Desk API address</label><input id="apiBase" className="input" value={s.apiBase} onChange={set("apiBase")} /></div>
        <div className="field"><label htmlFor="apiKey">Agent key</label><input id="apiKey" className="input" type="password" value={s.apiKey} onChange={set("apiKey")} placeholder="Leave blank for local development" /></div>
        <div className="field"><label htmlFor="agentId">Agent name</label><input id="agentId" className="input" value={s.agentId} onChange={set("agentId")} /></div>
        <div className="field"><label htmlFor="buyer">Buyer account</label><input id="buyer" className="input" value={s.buyer} onChange={set("buyer")} /></div>
      </div>
      <button className="btn btn-primary btn-sm" style={{ marginTop: 18 }} type="submit">Save</button>
    </form>
  );
}

export default function Desk() {
  const [rows, setRows] = useState<DeskClause[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .clauses()
      .then((r) => alive && (setRows(r), setError(null)))
      .catch((e: unknown) => alive && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [tick]);

  return (
    <>
      <PageHead eyebrow="The desk" title="Clauses" soft="you have written, and where each one stands.">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link className="btn btn-primary" to="/desk/new">Write a clause</Link>
          <button className="btn btn-ghost" onClick={() => setShowSettings((v) => !v)}>{showSettings ? "Close settings" : "Settings"}</button>
          <Link className="btn btn-ghost" to="/mandate">View mandate</Link>
        </div>
      </PageHead>
      <div className="wrap" style={{ display: "grid", gap: 16, paddingBottom: 96 }}>
        {showSettings && <Settings onSaved={() => (setShowSettings(false), setTick((t) => t + 1))} />}
        {error && <ApiDown message={`${error}.`} />}
        {rows && rows.length === 0 && (
          <div className="card card-pad" style={{ textAlign: "center", padding: 56 }}>
            <h2 className="h3">No clauses yet</h2>
            <p className="muted">Write one to hold a payment for a job. The person you pay gets a link.</p>
            <Link className="btn btn-primary" to="/desk/new" style={{ marginTop: 10 }}>Write the first clause</Link>
          </div>
        )}
        {rows && rows.length > 0 && (
          <div className="card table-wrap">
            <table className="table">
              <thead>
                <tr><th>Terms</th><th>Payee</th><th>Amount</th><th>Status</th><th>Account</th><th>Deadline</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.proposal.id}>
                    <td style={{ maxWidth: 320 }}>
                      <Link to={`/clause/${r.proposal.id}`} style={{ color: "var(--text)" }}>{r.proposal.terms}</Link>
                      <div className="faint" style={{ fontSize: 12 }}>{shortDate(r.proposal.submittedAt)}</div>
                    </td>
                    <td className="mono">{r.proposal.payee}</td>
                    <td className="mono">{r.proposal.amount.toFixed(2)} {r.proposal.asset}</td>
                    <td>
                      <StatusChip status={statusOf(r)} />
                      {r.refusedBy.length > 0 && <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>{r.refusedBy.join(", ")}</div>}
                    </td>
                    <td className="mono faint">{r.clauseAccountId ?? "not written yet"}</td>
                    <td className="faint">{r.decision === "VETO" ? "" : timeLeft(r.proposal.deadline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
