import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiDown, PageHead } from "../components/Page";
import { api, ApiError, loadSettings, type OpenInviteResult } from "../lib/api";

export default function NewClause() {
  const [params] = useSearchParams();
  const settings = loadSettings();
  const [form, setForm] = useState({
    payee: params.get("payee") ?? "",
    amount: "2",
    asset: "USDC",
    terms: "",
    deadlineMinutes: "15",
    challengeSecs: "0",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OpenInviteResult | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.openInvite({
          agentId: settings.agentId,
          mandateId: settings.mandateId,
          buyer: settings.buyer,
          payee: form.payee.trim(),
          amount: Number(form.amount),
          asset: form.asset,
          terms: form.terms.trim(),
          deadlineMinutes: Number(form.deadlineMinutes),
          challengeSecs: Number(form.challengeSecs),
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inviteUrl = result?.invite ? `${window.location.origin}${result.invite.path}` : null;

  return (
    <>
      <PageHead eyebrow="Write a clause" title="What should be delivered," soft="and what is it worth?" />
      <div className="wrap split" style={{ paddingBottom: 96 }}>
        <form className="card card-pad" onSubmit={submit} style={{ display: "grid", gap: 16 }}>
          <div className="field">
            <label htmlFor="payee">Pay this NEAR account</label>
            <input id="payee" className="input mono" required placeholder="editor.near" value={form.payee} onChange={set("payee")} />
          </div>
          <div className="field">
            <label htmlFor="terms">Terms</label>
            <textarea id="terms" className="textarea" required maxLength={2000} placeholder="Cut intro.mp4 to 30 seconds. Delivery is the file hash." value={form.terms} onChange={set("terms")} />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="amount">Amount</label>
              <input id="amount" className="input mono" required inputMode="decimal" value={form.amount} onChange={set("amount")} />
            </div>
            <div className="field">
              <label htmlFor="asset">Asset</label>
              <select id="asset" className="select" value={form.asset} onChange={set("asset")}>
                <option>USDC</option>
                <option>USDT</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="deadline">Expires after (minutes)</label>
              <input id="deadline" className="input mono" required inputMode="numeric" value={form.deadlineMinutes} onChange={set("deadlineMinutes")} />
            </div>
            <div className="field">
              <label htmlFor="challenge">Review window after delivery (seconds)</label>
              <input id="challenge" className="input mono" inputMode="numeric" value={form.challengeSecs} onChange={set("challengeSecs")} />
            </div>
          </div>
          <p className="faint" style={{ fontSize: 13, margin: 0 }}>
            Funded by <span className="mono">{settings.buyer}</span>. If nothing is delivered in time, the money returns there.
          </p>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Checking the mandate" : "Check and open an invite"}</button>
        </form>

        <div style={{ display: "grid", gap: 16, alignContent: "start" }}>
          {!result && !error && (
            <div className="card card-pad">
              <h2 className="h3">What happens next</h2>
              <ol className="timeline" style={{ marginTop: 16 }}>
                <li><div>The mandate checks the clause</div><div className="faint" style={{ fontSize: 13 }}>Before anyone signs. A refusal names the rule.</div></li>
                <li><div>You send the payee a link</div><div className="faint" style={{ fontSize: 13 }}>Their browser makes the only key the clause will accept.</div></li>
                <li><div>The clause is written and funded</div><div className="faint" style={{ fontSize: 13 }}>From any chain, through NEAR Intents.</div></li>
                <li><div>Delivery releases the money</div><div className="faint" style={{ fontSize: 13 }}>Or the deadline returns it to you.</div></li>
              </ol>
            </div>
          )}
          {error && <ApiDown message={`${error}.`} />}
          {result && (
            <div className="card card-pad">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <h2 className="h3">{result.verdict.decision === "PASS" ? "Cleared" : result.verdict.decision === "ESCALATE" ? "Needs a second person" : "Refused before signature"}</h2>
                <span className={`chip ${result.verdict.decision === "PASS" ? "chip-released" : result.verdict.decision === "ESCALATE" ? "chip-funded" : "chip-refused"}`}>{result.verdict.decision}</span>
              </div>
              <div className="mini" style={{ marginTop: 16 }}>
                {result.verdict.reasons.map((r) => (
                  <div className="mini-row" key={r.rule}>
                    <span style={{ color: r.outcome === "violated" ? "var(--red)" : r.outcome === "warning" ? "var(--amber)" : "var(--muted)" }}>{r.rule}</span>
                    <span className="faint" style={{ textAlign: "right", fontSize: 12.5 }}>{r.detail}</span>
                  </div>
                ))}
              </div>
              {inviteUrl && (
                <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
                  <div className="notice notice-violet">Send this link to the payee. It is the only way to bind the key that can deliver.</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="input mono" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(inviteUrl)}>Copy</button>
                  </div>
                  <Link className="link-arrow" to={`/clause/${result.proposalId}`}>Open the clause</Link>
                </div>
              )}
              {result.approval && <p className="muted" style={{ fontSize: 14 }}>A different person approves it with <code className="mono">clausehold approve {result.approval.approvalId.slice(0, 8)}</code>.</p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
