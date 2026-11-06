import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiDown, PageHead, shortDate, timeLeft } from "../components/Page";
import { StatusChip } from "../components/Status";
import { api, ApiError, statusOf, type DeskClause } from "../lib/api";
import { useNetwork } from "../lib/network";

const STEPS = ["awaiting", "open", "funded", "delivered", "released"] as const;

export default function ClauseDetail() {
  const { id = "" } = useParams();
  const { network } = useNetwork();
  const [row, setRow] = useState<DeskClause | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fund, setFund] = useState({ originAsset: "", refundTo: "" });
  const [quote, setQuote] = useState<{ address?: string; pay: string; get: string; eta: number } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    api
      .clauses()
      .then((rows) => {
        const r = rows.find((x) => x.proposal.id === id);
        r ? setRow(r) : setError("No clause with this id on your desk");
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [id]);

  async function getQuote(dry: boolean) {
    setQuoteError(null);
    try {
      const r = await api.fundQuote(id, { ...fund, dry });
      setQuote({ address: r.quote.quote.depositAddress, pay: r.quote.quote.amountInFormatted, get: r.quote.quote.amountOutFormatted, eta: r.quote.quote.timeEstimate });
    } catch (e) {
      setQuoteError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (error) {
    return (
      <div className="wrap page-head" style={{ paddingBottom: 96 }}>
        <ApiDown message={`${error}.`} />
        <Link className="link-arrow" to="/desk" style={{ marginTop: 16 }}>Back to the desk</Link>
      </div>
    );
  }
  if (!row) return <div className="wrap page-head faint">Loading the clause</div>;

  const status = statusOf(row);
  const p = row.proposal;
  const at = STEPS.indexOf(status as (typeof STEPS)[number]);

  return (
    <>
      <PageHead eyebrow={row.clauseAccountId ?? "Not written on chain yet"} title={p.terms}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <StatusChip status={status} />
          <span className="mono">{p.amount.toFixed(2)} {p.asset}</span>
          <span className="faint">to</span>
          <Link className="mono" to={`/s/${p.payee}`}>{p.payee}</Link>
          <span className="faint">{timeLeft(p.deadline)}</span>
        </div>
      </PageHead>
      <div className="wrap grid-2" style={{ paddingBottom: 96, alignItems: "start" }}>
        <div className="card card-pad">
          <h2 className="h3">Life of this clause</h2>
          <ol className="timeline" style={{ marginTop: 18 }}>
            {["Waiting for the payee's key", "Written on chain", "Funded", "Delivered", "Released"].map((label, i) => (
              <li key={label} className={at > i ? "done" : at === i ? "now" : ""}>
                <div style={{ color: at >= i ? "var(--text)" : "var(--faint)" }}>{label}</div>
              </li>
            ))}
          </ol>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Buyer</dt><dd className="mono">{p.buyer}</dd>
            <dt>Written</dt><dd>{shortDate(p.submittedAt)}</dd>
            <dt>Deadline</dt><dd>{shortDate(p.deadline)}</dd>
            <dt>Review window</dt><dd>{p.challengeSecs ? `${p.challengeSecs} seconds after delivery` : "None. Delivery releases at once."}</dd>
            {row.inviteId && <><dt>Payee link</dt><dd><Link className="mono" to={`/w/${row.inviteId}`}>/w/{row.inviteId.slice(0, 10)}...</Link></dd></>}
            {row.clauseAccountId && <><dt>Receipt</dt><dd><Link className="mono" to={`/r/${row.clauseAccountId}`}>View receipt</Link></dd></>}
          </dl>
        </div>

        <div className="card card-pad">
          <h2 className="h3">{network.intents ? "Fund through NEAR Intents" : "Fund with test money"}</h2>
          <p className="muted" style={{ fontSize: 14 }}>
            {network.intents
              ? `Pay from the chain you already hold. The clause account receives exactly ${p.amount.toFixed(2)} ${p.asset} on NEAR.`
              : `NEAR Intents runs on mainnet only. On testnet the clause holds a test stablecoin you can mint for free, sent straight to the clause account.`}
          </p>
          {status === "open" && !network.intents ? (
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <pre className="code" style={{ margin: 0 }}>
                <span className="c"># Send exactly the clause amount to the clause account</span>{"\n"}
                near call {network.usdc} ft_transfer \{"\n"}
                {"  "}<span className="s">{`'{"receiver_id":"${row.clauseAccountId}","amount":"${Math.round(p.amount * 1e6)}"}'`}</span> \{"\n"}
                {"  "}--accountId {p.buyer} --depositYocto 1
              </pre>
              <p className="faint" style={{ fontSize: 13, margin: 0 }}>Then anyone can call sync_funding on the clause, or the desk does it for you, and the status turns Funded.</p>
            </div>
          ) : status !== "open" ? (
            <div className="notice" style={{ marginTop: 12 }}>{status === "awaiting" ? "Funding opens once the payee has opened their link and the clause is written." : "This clause is past funding."}</div>
          ) : (
            <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
              <div className="field"><label htmlFor="origin">Asset you pay with (1Click asset id)</label><input id="origin" className="input mono" placeholder="nep141:base-0x833589f...omft.near" value={fund.originAsset} onChange={(e) => setFund({ ...fund, originAsset: e.target.value })} /></div>
              <div className="field"><label htmlFor="refund">Your address on that chain, for a failed swap</label><input id="refund" className="input mono" placeholder="0x..." value={fund.refundTo} onChange={(e) => setFund({ ...fund, refundTo: e.target.value })} /></div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-ghost btn-sm" onClick={() => getQuote(true)}>Preview the price</button>
                <button className="btn btn-primary btn-sm" onClick={() => getQuote(false)}>Get a deposit address</button>
              </div>
              {quoteError && <div className="notice notice-red">{quoteError}</div>}
              {quote && (
                <div className="mini">
                  <div className="mini-row"><span className="faint">You send</span><span className="mono">{quote.pay}</span></div>
                  <div className="mini-row"><span className="faint">Clause receives</span><span className="mono">{quote.get} {p.asset}</span></div>
                  <div className="mini-row"><span className="faint">About</span><span>{quote.eta} seconds</span></div>
                  {quote.address && <div className="mini-row"><span className="faint">Send to</span><span className="mono" style={{ wordBreak: "break-all" }}>{quote.address}</span></div>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
