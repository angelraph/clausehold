import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHead } from "../components/Page";
import { StatusChip } from "../components/Status";
import { useNetwork } from "../lib/network";
import { chainTime, earnedLimit, readFactoryMandate, readReceipts, readStanding, tokenAmount, tokenSymbol, type ChainMandate, type ChainReceipt, type RoleStats, type Standing as StandingView } from "../lib/records";

/**
 * An account's track record, read from the factory contract: how many
 * clauses it was paid through, and how many it paid for. Nobody can edit it.
 */
export default function Standing() {
  const { account = "" } = useParams();
  const { network } = useNetwork();
  const [standing, setStanding] = useState<StandingView | null>(null);
  const [receipts, setReceipts] = useState<ChainReceipt[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [mandate, setMandate] = useState<ChainMandate | null>(null);

  useEffect(() => {
    setStanding(null);
    setReceipts(null);
    setFailed(false);
    Promise.all([readStanding(network, account), readReceipts(network, account), readFactoryMandate(network).catch(() => null)])
      .then(([s, r, m]) => {
        setStanding(s);
        setMandate(m);
        setReceipts([...r].sort((a, b) => b.at - a.at));
      })
      .catch(() => setFailed(true));
  }, [network, account]);

  const symbol = tokenSymbol(network, network.usdc);

  return (
    <>
      <PageHead eyebrow="Standing" title={account} soft={`on ${network.label}.`} />
      <div className="wrap" style={{ paddingBottom: 96, display: "grid", gap: 16 }}>
        {failed && <div className="notice" style={{ maxWidth: 640 }}>The factory on {network.label} did not answer. Try again in a moment.</div>}
        {!standing && !failed && <p className="faint">Reading the record from the chain</p>}
        {standing && (
          <div className="grid-2">
            <Role title="As a payee" note="Clauses this account was paid through." stats={standing.as_payee} symbol={symbol} paidLabel="Received" />
            <Role title="As a buyer" note="Clauses this account paid for." stats={standing.as_buyer} symbol={symbol} paidLabel="Paid out" />
          </div>
        )}
        {standing && mandate && <Earned account={account} standing={standing} mandate={mandate} symbol={symbol} apiBase={network.apiBase} />}
        {receipts && (
          <div className="card table-wrap">
            {receipts.length === 0 ? (
              <p className="muted card-pad" style={{ margin: 0 }}>No settled clauses yet. A payee with none can be offered at most the mandate's new-payee ceiling.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Clause</th><th>Outcome</th><th>Amount</th><th>Buyer</th><th>Payee</th><th>Settled</th></tr>
                </thead>
                <tbody>
                  {receipts.map((r) => (
                    <tr key={r.account_id}>
                      <td className="mono"><Link to={`/r/${r.account_id}`}>{r.account_id}</Link></td>
                      <td><StatusChip status={r.outcome} /></td>
                      <td className="mono">{tokenAmount(r.paid)} {tokenSymbol(network, r.asset)}</td>
                      <td className="mono faint">{r.buyer}</td>
                      <td className="mono faint">{r.payee}</td>
                      <td className="faint">{chainTime(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <p className="faint" style={{ fontSize: 13, maxWidth: 640, margin: 0 }}>
          Read from the factory contract <span className="mono">{network.factory}</span>. A payee with released clauses can be offered more than the new-payee ceiling allows.
        </p>
      </div>
    </>
  );
}

function Role({ title, note, stats, symbol, paidLabel }: { title: string; note: string; stats: RoleStats; symbol: string; paidLabel: string }) {
  return (
    <div className="card card-pad">
      <h2 className="h3">{title}</h2>
      <p className="faint" style={{ fontSize: 13, margin: "4px 0 0" }}>{note}</p>
      <div className="mini" style={{ marginTop: 16 }}>
        <div className="mini-row"><span className="faint">Released</span><span className="mono">{stats.released}</span></div>
        <div className="mini-row"><span className="faint">Returned</span><span className="mono">{stats.returned}</span></div>
        <div className="mini-row"><span className="faint">Open now</span><span className="mono">{stats.open}</span></div>
        <div className="mini-row"><span className="faint">{paidLabel}</span><span className="mono" style={{ color: "var(--text)" }}>{tokenAmount(stats.released_volume)} {symbol}</span></div>
      </div>
    </div>
  );
}

/** What this payee's record unlocks under the current mandate, plus a badge anyone can embed. */
function Earned({ account, standing, mandate, symbol, apiBase }: { account: string; standing: StandingView; mandate: ChainMandate; symbol: string; apiBase: string }) {
  const { limit, lifted } = earnedLimit(standing, mandate);
  const page = `${window.location.origin}/s/${account}`;
  const badge = `${apiBase}/standing/${account}/badge.svg`;
  const snippet = `[![Clausehold standing](${badge})](${page})`;
  return (
    <div className="grid-2">
      <div className="card card-pad">
        <h2 className="h3">Limit this account has earned</h2>
        <div className="mono" style={{ fontSize: 28, marginTop: 10, color: "var(--text)" }}>{tokenAmount(limit)} {symbol}</div>
        <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
          {lifted
            ? <>Lifted to the full per-clause cap, because {standing.as_payee.released} {standing.as_payee.released === 1 ? "clause was" : "clauses were"} released to this account.</>
            : <>Held at the new-payee ceiling until one clause is released to this account. Then it rises to {tokenAmount(mandate.max_per_clause)} {symbol}.</>}
        </p>
        <p className="faint" style={{ fontSize: 13, margin: 0 }}>The factory checks this when a clause is written. No one can skip it.</p>
      </div>
      <div className="card card-pad" style={{ display: "grid", gap: 10, alignContent: "start" }}>
        <h2 className="h3">Show it anywhere</h2>
        <img src={badge} alt={`Clausehold standing for ${account}`} height={20} style={{ justifySelf: "start" }} />
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>Put this on a profile or a README. It is drawn from the chain, and it links back here so anyone can check it.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input className="input mono" readOnly value={snippet} onFocus={(e) => e.currentTarget.select()} aria-label="Badge markdown" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(snippet)}>Copy</button>
        </div>
      </div>
    </div>
  );
}