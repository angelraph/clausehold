import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PageHead } from "../components/Page";
import { useNetwork } from "../lib/network";
import { chainTime, rankPayees, readAllReceipts, readFactoryMandate, tokenAmount, tokenSymbol, type ChainMandate, type LeaderRow } from "../lib/records";

/**
 * Earned standing for everyone, read straight from the factory. A payee climbs
 * only by being paid through released clauses, and that is what lifts their limit.
 */
export default function Leaderboard() {
  const { network } = useNetwork();
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [mandate, setMandate] = useState<ChainMandate | null>(null);
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const [lookup, setLookup] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    setRows(null);
    setFailed(false);
    Promise.all([readAllReceipts(network), readFactoryMandate(network)])
      .then(([receipts, m]) => {
        setCount(receipts.length);
        setRows(rankPayees(receipts));
        setMandate(m);
      })
      .catch(() => setFailed(true));
  }, [network]);

  const sym = tokenSymbol(network, network.usdc);

  return (
    <>
      <PageHead eyebrow="Standing" title="Limits are earned, not granted." soft="Every released clause is a line nobody can edit." />
      <div className="wrap" style={{ paddingBottom: 96, display: "grid", gap: 16 }}>
        <div className="grid-2">
          <div className="card card-pad">
            <h2 className="h3">How a payee earns more</h2>
            <p className="muted" style={{ fontSize: 15, marginTop: 10 }}>
              A payee nobody has paid yet can be offered at most the mandate's new-payee ceiling
              {mandate && <> ({tokenAmount(mandate.new_payee_ceiling)} {sym})</>}. After one clause is released to them, the factory lifts that to the full per-clause cap
              {mandate && <> ({tokenAmount(mandate.max_per_clause)} {sym})</>}. The factory checks this itself when a clause is written, so no desk, agent or person can skip it.
            </p>
          </div>
          <form
            className="card card-pad"
            onSubmit={(e) => {
              e.preventDefault();
              if (lookup.trim()) navigate(`/s/${encodeURIComponent(lookup.trim())}`);
            }}
            style={{ display: "grid", gap: 10, alignContent: "start" }}
          >
            <h2 className="h3">Look up any account</h2>
            <input className="input mono" placeholder={network.id === "testnet" ? "editor.testnet" : "editor.near"} value={lookup} onChange={(e) => setLookup(e.target.value)} aria-label="NEAR account" />
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} type="submit">See its standing</button>
          </form>
        </div>

        {failed && <div className="notice">The factory on {network.label} did not answer. Try again in a moment.</div>}
        {!rows && !failed && <p className="faint">Reading every receipt from the chain</p>}
        {rows && (
          <div className="card table-wrap">
            {rows.length === 0 ? (
              <p className="muted card-pad" style={{ margin: 0 }}>No clause has settled on {network.label} yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>#</th><th>Payee</th><th>Released</th><th>Returned</th><th>Paid to them</th><th>Last settled</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.payee}>
                      <td className="faint">{i + 1}</td>
                      <td className="mono"><Link to={`/s/${r.payee}`}>{r.payee}</Link></td>
                      <td className="mono">{r.released}</td>
                      <td className="mono faint">{r.returned}</td>
                      <td className="mono">{tokenAmount(r.volume.toString())} {sym}</td>
                      <td className="faint">{chainTime(r.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <p className="faint" style={{ fontSize: 13, margin: 0 }}>
          {count > 0 && <>{count} receipts, </>}read from the factory contract <span className="mono">{network.factory}</span>.
        </p>
      </div>
    </>
  );
}
