import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHead } from "../components/Page";
import { StatusChip } from "../components/Status";
import { explorerAccount, useNetwork } from "../lib/network";
import { chainTime, readClause, tokenAmount, tokenSymbol, type ClauseView } from "../lib/records";

/**
 * A public receipt, read straight from the clause account on chain. Nothing
 * here comes from the desk, so anyone can check it without trusting us.
 */
export default function Receipt() {
  const { clause = "" } = useParams();
  const { network } = useNetwork();
  const [c, setC] = useState<ClauseView | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setC(null);
    setMissing(false);
    readClause(network, clause).then(setC).catch(() => setMissing(true));
  }, [network, clause]);

  const symbol = c ? tokenSymbol(network, c.asset) : "";
  const settled = c?.state === "released" || c?.state === "returned";

  return (
    <>
      <PageHead eyebrow="Public receipt" title={clause} soft="on NEAR." />
      <div className="wrap grid-2" style={{ paddingBottom: 96, alignItems: "start" }}>
        <div className="card card-pad">
          {missing && (
            <div className="notice">
              There is no clause at <span className="mono">{clause}</span> on {network.label}. If it was written on the other network, switch at the top.
            </div>
          )}
          {!c && !missing && <p className="faint" style={{ margin: 0 }}>Reading the clause from the chain</p>}
          {c && (
            <>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <StatusChip status={c.state} />
                <span className="mono" style={{ fontSize: 20 }}>{tokenAmount(c.amount)} {symbol}</span>
              </div>
              <p className="muted" style={{ fontSize: 15, marginTop: 14 }}>
                {c.state === "released" && <>Paid to <span className="mono">{c.payee}</span> after delivery.</>}
                {c.state === "returned" && <>Nothing was delivered in time, so the money went back to <span className="mono">{c.buyer}</span>.</>}
                {c.state === "delivered" && <>Delivered. The money releases when the review window ends.</>}
                {c.state === "frozen" && <>The buyer froze it after delivery. It moves when the buyer and the co-signer agree.</>}
                {(c.state === "open" || c.state === "funded") && <>Not settled yet. It releases on delivery, or returns to the buyer after the deadline.</>}
              </p>
              <dl className="kv" style={{ marginTop: 8 }}>
                <dt>Paid by</dt><dd className="mono"><Link to={`/s/${c.buyer}`}>{c.buyer}</Link></dd>
                <dt>Paid to</dt><dd className="mono"><Link to={`/s/${c.payee}`}>{c.payee}</Link></dd>
                {settled && <><dt>Moved</dt><dd className="mono">{tokenAmount(c.paid)} {symbol} to {c.state === "released" ? c.payee : c.buyer}</dd></>}
                <dt>Deadline</dt><dd>{chainTime(c.deadline)}</dd>
                {c.delivered_at && <><dt>Delivered</dt><dd>{chainTime(c.delivered_at)}</dd></>}
                <dt>Review window</dt><dd>{c.challenge_secs ? `${c.challenge_secs} seconds` : "None"}</dd>
                <dt>Terms hash</dt><dd className="mono" style={{ wordBreak: "break-all", fontSize: 12.5 }}>{c.terms_hash}</dd>
                {c.delivery_hash && <><dt>Delivery hash</dt><dd className="mono" style={{ wordBreak: "break-all", fontSize: 12.5 }}>{c.delivery_hash}</dd></>}
                {c.note_hash && <><dt>NEAR AI note</dt><dd className="mono" style={{ wordBreak: "break-all", fontSize: 12.5 }}>{c.note_hash}</dd></>}
                <dt>Worker key</dt><dd className="mono" style={{ wordBreak: "break-all", fontSize: 12.5 }}>{c.worker_pk}</dd>
              </dl>
            </>
          )}
        </div>
        <div className="card card-pad">
          <h2 className="h3">Check it yourself</h2>
          <p className="muted" style={{ fontSize: 15 }}>
            Everything on this page is read from the clause account itself. Every step also logged a public event, so the explorer shows the same story, transaction by transaction.
          </p>
          <a className="btn btn-ghost btn-sm" href={explorerAccount(network, clause)} target="_blank" rel="noreferrer">Open in the explorer</a>
          {c && (
            <p className="faint" style={{ fontSize: 13, marginTop: 16 }}>
              The worker key above is the only key on this account. It can call <span className="mono">submit_delivery</span> and nothing else.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
