import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiDown, PageHead, deadlineNote, shortDate } from "../components/Page";
import { StatusChip } from "../components/Status";
import { WalletButton } from "../components/WalletButton";
import { api, ApiError, statusOf, type DeskClause } from "../lib/api";
import { nearBalance, tokenBalance, toBaseUnits6, view } from "../lib/chain";
import { assetLabel, explorerAccount, useNetwork, type NetworkProfile } from "../lib/network";
import { useWallet } from "../lib/wallet";

const STEPS = ["awaiting", "open", "funded", "delivered", "released"] as const;

export default function ClauseDetail() {
  const { id = "" } = useParams();
  const [row, setRow] = useState<DeskClause | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { network } = useNetwork();

  const load = useCallback(
    () =>
      api
        .clauses()
        .then((rows) => {
          const r = rows.find((x) => x.proposal.id === id);
          r ? setRow(r) : setError("No clause with this id on the desk");
        })
        .catch((e: unknown) => setError(e instanceof ApiError ? e.message : String(e))),
    [id]
  );

  useEffect(() => {
    load();
  }, [load]);

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
          <span className="mono">{p.amount.toFixed(2)} {assetLabel(network, p.asset)}</span>
          <span className="faint">to</span>
          <Link className="mono" to={`/s/${p.payee}`}>{p.payee}</Link>
          {deadlineNote(status, p.deadline) && <span className="faint">{deadlineNote(status, p.deadline)}</span>}
        </div>
      </PageHead>
      <div className="wrap grid-2" style={{ paddingBottom: 96, alignItems: "start" }}>
        <div className="card card-pad">
          <h2 className="h3">Life of this clause</h2>
          <ol className="timeline" style={{ marginTop: 18 }}>
            {["Waiting for the payee to accept", "Written on chain", "Funded", "Delivered", "Released"].map((label, i) => (
              <li key={label} className={at > i ? "done" : at === i ? "now" : ""}>
                <div style={{ color: at >= i ? "var(--text)" : "var(--faint)" }}>{label}</div>
              </li>
            ))}
          </ol>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Buyer</dt><dd className="mono">{p.buyer}</dd>
            <dt>Opened</dt><dd>{shortDate(p.submittedAt)}</dd>
            <dt>Deadline</dt><dd>{shortDate(p.deadline)}</dd>
            <dt>Review window</dt><dd>{p.challengeSecs ? `${p.challengeSecs} seconds after delivery` : "None. Delivery releases at once."}</dd>
            {row.inviteId && <><dt>Payee link</dt><dd><Link className="mono" to={`/w/${row.inviteId}`}>/w/{row.inviteId.slice(0, 10)}...</Link></dd></>}
            {row.clauseAccountId && <><dt>Receipt</dt><dd><Link className="mono" to={`/r/${row.clauseAccountId}`}>View receipt</Link></dd></>}
          </dl>
        </div>

        <BuyerPanel row={row} status={status} onChange={load} />
      </div>
    </>
  );
}

type Status = ReturnType<typeof statusOf>;

/** What the buyer does next, signed by their own wallet. */
function BuyerPanel({ row, status, onChange }: { row: DeskClause; status: Status; onChange: () => void }) {
  const { network } = useNetwork();
  const w = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const p = row.proposal;
  const isBuyer = !!w.accountId && w.accountId === p.buyer;
  const expired = new Date(p.deadline).getTime() <= Date.now();
  const symbol = network.id === "testnet" ? "mUSD" : "USDC";

  useEffect(() => {
    if (w.accountId && status === "open") tokenBalance(network, w.accountId).then(setHeld);
  }, [w.accountId, status, network]);

  async function step(label: string, run: () => Promise<string>) {
    setBusy(label);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await run() });
      onChange();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const write = () =>
    step("write", async () => {
      const c = await api.createCall(row.inviteId!);
      const r = await w.call({ receiverId: c.receiverId, methodName: c.methodName, args: c.args, gas: c.gas, deposit: c.deposit });
      const account = typeof r.value === "string" ? r.value : await findClauseByKey(network, c.args.worker_pk);
      if (!account) throw new Error("The factory did not create the clause. Your deposit was refunded.");
      await api.written(row.inviteId!, account, r.txHash);
      return `Written on chain at ${account}. Fund it next.`;
    });

  const fund = () =>
    step("fund", async () => {
      await w.call({
        receiverId: network.usdc,
        methodName: "ft_transfer_call",
        args: { receiver_id: row.clauseAccountId, amount: toBaseUnits6(p.amount), msg: "" },
        gas: "100000000000000",
        deposit: "1",
      });
      return `Funded with ${p.amount.toFixed(2)} ${symbol}. The payee can deliver now.`;
    });

  const giveBack = () =>
    step("return", async () => {
      await w.call({ receiverId: row.clauseAccountId!, methodName: "expire", args: {}, gas: "150000000000000", deposit: "0" });
      return `Returned. The ${symbol} is back with ${p.buyer}.`;
    });

  const inviteUrl = row.inviteId ? `${window.location.origin}/w/${row.inviteId}` : null;
  const connect = !w.accountId && (
    <div style={{ display: "grid", gap: 10, justifyItems: "start" }}>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Connect <span className="mono">{p.buyer}</span> to continue. It signs and pays from its own balance.</p>
      <WalletButton />
    </div>
  );
  const notBuyer = w.accountId && !isBuyer && (
    <div className="notice">You are connected as <span className="mono">{w.accountId}</span>. Only <span className="mono">{p.buyer}</span> can write this clause. Switch wallet from the menu at the top.</div>
  );

  let body: React.ReactNode;
  if (status === "refused") {
    body = <p className="muted">The mandate refused this clause before anyone signed, so nothing was written and no money moved.</p>;
  } else if (status === "expired") {
    body = (
      <div style={{ display: "grid", gap: 12, justifyItems: "start" }}>
        <p className="muted" style={{ margin: 0 }}>The deadline passed before this clause was written on chain, so nothing was signed and no money moved.</p>
        <Link className="btn btn-ghost btn-sm" to={`/desk/new?payee=${encodeURIComponent(p.payee)}`}>Write it again</Link>
      </div>
    );
  } else if (status === "awaiting" && row.inviteStatus === "awaiting_key") {
    body = (
      <div style={{ display: "grid", gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>Send this link to the payee. When they accept, their browser makes the one key that can deliver, and you write the clause.</p>
        {inviteUrl && (
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input mono" readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(inviteUrl)}>Copy</button>
          </div>
        )}
        <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={onChange}>Check again</button>
      </div>
    );
  } else if (status === "awaiting") {
    body = (
      <div style={{ display: "grid", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          The payee accepted. Writing the clause creates its own account on chain, bound to their key. Your wallet puts down about 2 NEAR to store that account and its code on chain, plus a small network fee. You get the 2 NEAR back when the clause settles and is closed.
        </p>
        {connect || notBuyer || (
          <button className="btn btn-primary" onClick={write} disabled={!!busy}>{busy === "write" ? "Waiting for your wallet" : "Write the clause"}</button>
        )}
      </div>
    );
  } else if (status === "open") {
    body = (
      <div style={{ display: "grid", gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          Send exactly {p.amount.toFixed(2)} {symbol} into the clause. It stays there until the payee delivers, or comes back to you after the deadline.
          {held !== null && <> You hold <span className="mono" style={{ color: "var(--text)" }}>{held.toFixed(2)} {symbol}</span>.</>}
        </p>
        {connect || (
          <>
            <button className="btn btn-primary" onClick={fund} disabled={!!busy || (held !== null && held < p.amount)}>
              {busy === "fund" ? "Waiting for your wallet" : `Fund ${p.amount.toFixed(2)} ${symbol}`}
            </button>
            {held !== null && held < p.amount && network.id === "testnet" && (
              <p className="faint" style={{ margin: 0, fontSize: 13 }}>Not enough mUSD. <Link className="link-arrow" to="/faucet">Get 100 free</Link></p>
            )}
          </>
        )}
        {network.intents && <IntentsFunding proposalId={p.id} amount={p.amount} asset={p.asset} />}
      </div>
    );
  } else if (status === "funded") {
    body = <p className="muted" style={{ margin: 0 }}>Funded. Waiting for {p.payee} to deliver before the deadline. Delivery releases the money to them at once.</p>;
  } else if (status === "delivered" || status === "frozen") {
    body = <p className="muted" style={{ margin: 0 }}>Delivered. The money releases when the review window ends.</p>;
  } else {
    body = (
      <p className="muted" style={{ margin: 0 }}>
        {status === "released" ? `Settled: ${p.payee} was paid.` : `Settled: the money went back to ${p.buyer}.`}{" "}
        {row.clauseAccountId && <Link className="link-arrow" to={`/r/${row.clauseAccountId}`}>See the receipt</Link>}
      </p>
    );
  }

  const canReturn = expired && row.clauseAccountId && (status === "open" || status === "funded");

  return (
    <div className="card card-pad" style={{ display: "grid", gap: 14 }}>
      <h2 className="h3">Your part</h2>
      {body}
      {canReturn && (
        <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>The deadline passed with no delivery. Anyone can send the money back to the buyer.</p>
          {w.accountId ? (
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={giveBack} disabled={!!busy}>{busy === "return" ? "Waiting for your wallet" : "Return the money"}</button>
          ) : (
            <WalletButton />
          )}
        </div>
      )}
      {msg && <div className={`notice ${msg.ok ? "notice-green" : "notice-red"}`}>{msg.text}</div>}
      {row.clauseAccountId && (status === "released" || status === "returned") && <Reclaim account={row.clauseAccountId} buyer={p.buyer} />}
      {row.clauseAccountId && (
        <a className="link-arrow" style={{ fontSize: 14 }} href={explorerAccount(network, row.clauseAccountId)} target="_blank" rel="noreferrer">See the clause account on the explorer</a>
      )}
    </div>
  );
}

/**
 * A settled clause still holds the NEAR that stored its code. Closing it
 * deletes the account and sends that NEAR to the buyer. Anyone may do it;
 * clauses written before `close` existed simply keep their account.
 */
function Reclaim({ account, buyer }: { account: string; buyer: string }) {
  const { network } = useNetwork();
  const w = useWallet();
  const [state, setState] = useState<"loading" | "closed" | "old" | "waiting" | "open">("loading");
  const [held, setHeld] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const check = useCallback(async () => {
    const near = await nearBalance(network, account);
    if (near === null) return setState("closed");
    setHeld(near);
    try {
      const c = await view<{ reported?: boolean }>(network, account, "get_clause");
      setState(c.reported === undefined ? "old" : c.reported ? "open" : "waiting");
    } catch {
      setState("old");
    }
  }, [network, account]);

  useEffect(() => {
    check();
  }, [check]);

  async function close() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await w.call({ receiverId: account, methodName: "close", args: {}, gas: "100000000000000", deposit: "0" });
      if (r.value === false) {
        // Leftover tokens block it. Sweep them to the buyer, then ask again.
        await w.call({ receiverId: account, methodName: "sync_funding", args: {}, gas: "150000000000000", deposit: "0" });
        setMsg({ ok: false, text: `The clause still held some tokens, so they were sent to ${buyer}. Close it again to finish.` });
      } else {
        setMsg({ ok: true, text: `Closed. About ${held?.toFixed(2) ?? "2"} NEAR went back to ${buyer}.` });
      }
      await check();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading" || state === "old") return null;
  return (
    <div style={{ display: "grid", gap: 8, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      {state === "closed" && <p className="muted" style={{ margin: 0, fontSize: 14 }}>Closed. The NEAR that stored this clause went back to <span className="mono">{buyer}</span>. The receipt stays on the factory.</p>}
      {state === "waiting" && <p className="muted" style={{ margin: 0, fontSize: 14 }}>Waiting for the factory to record the outcome. After that, the clause can be closed.</p>}
      {state === "open" && (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            The clause account still holds about {held?.toFixed(2)} NEAR that paid for its storage. Closing it sends that NEAR back to <span className="mono">{buyer}</span>. Anyone can close it; it costs a small network fee.
          </p>
          {w.accountId ? (
            <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={close} disabled={busy}>{busy ? "Waiting for your wallet" : "Close it and return the NEAR"}</button>
          ) : (
            <WalletButton />
          )}
        </>
      )}
      {msg && <div className={`notice ${msg.ok ? "notice-green" : "notice-red"}`}>{msg.text}</div>}
    </div>
  );
}

/** If the wallet did not report the new account, find it on the factory by the payee's key. */
async function findClauseByKey(network: NetworkProfile, workerPk: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const count = await view<number>(network, network.factory, "clause_count");
      const recent = await view<Array<{ account_id: string; worker_pk: string }>>(network, network.factory, "get_clauses", { from_index: Math.max(0, count - 50), limit: 50 });
      const hit = recent.find((c) => c.worker_pk === workerPk);
      if (hit) return hit.account_id;
    } catch {
      /* the RPC node may lag a block behind the wallet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** Mainnet only: pay from another chain through NEAR Intents. */
function IntentsFunding({ proposalId, amount, asset }: { proposalId: string; amount: number; asset: string }) {
  const [open, setOpen] = useState(false);
  const [fund, setFund] = useState({ originAsset: "", refundTo: "" });
  const [quote, setQuote] = useState<{ address?: string; pay: string; get: string; eta: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function getQuote(dry: boolean) {
    setError(null);
    try {
      const r = await api.fundQuote(proposalId, { ...fund, dry });
      setQuote({ address: r.quote.quote.depositAddress, pay: r.quote.quote.amountInFormatted, get: r.quote.quote.amountOutFormatted, eta: r.quote.quote.timeEstimate });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  }

  if (!open) {
    return <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start" }} onClick={() => setOpen(true)}>Pay from another chain instead</button>;
  }
  return (
    <div style={{ display: "grid", gap: 12, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Through NEAR Intents. The clause receives exactly {amount.toFixed(2)} {asset} on NEAR.</p>
      <div className="field"><label htmlFor="origin">Asset you pay with (1Click asset id)</label><input id="origin" className="input mono" placeholder="nep141:base-0x833589f...omft.near" value={fund.originAsset} onChange={(e) => setFund({ ...fund, originAsset: e.target.value })} /></div>
      <div className="field"><label htmlFor="refund">Your address on that chain, for a failed swap</label><input id="refund" className="input mono" placeholder="0x..." value={fund.refundTo} onChange={(e) => setFund({ ...fund, refundTo: e.target.value })} /></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-ghost btn-sm" onClick={() => getQuote(true)}>Preview the price</button>
        <button className="btn btn-primary btn-sm" onClick={() => getQuote(false)}>Get a deposit address</button>
      </div>
      {error && <div className="notice notice-red">{error}</div>}
      {quote && (
        <div className="mini">
          <div className="mini-row"><span className="faint">You send</span><span className="mono">{quote.pay}</span></div>
          <div className="mini-row"><span className="faint">Clause receives</span><span className="mono">{quote.get} {asset}</span></div>
          <div className="mini-row"><span className="faint">About</span><span>{quote.eta} seconds</span></div>
          {quote.address && <div className="mini-row"><span className="faint">Send to</span><span className="mono" style={{ wordBreak: "break-all" }}>{quote.address}</span></div>}
        </div>
      )}
    </div>
  );
}
