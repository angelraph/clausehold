import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHead } from "../components/Page";
import { StatusChip } from "../components/Status";
import { useNetwork } from "../lib/network";
import { chainTime, readReceipts, readStanding, tokenAmount, tokenSymbol, type ChainReceipt, type RoleStats, type Standing as StandingView } from "../lib/records";

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

  useEffect(() => {
    setStanding(null);
    setReceipts(null);
    setFailed(false);
    Promise.all([readStanding(network, account), readReceipts(network, account)])
      .then(([s, r]) => {
        setStanding(s);
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
