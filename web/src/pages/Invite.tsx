import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiDown, timeLeft } from "../components/Page";
import { StatusChip } from "../components/Status";
import { LogoMark } from "../components/Logo";
import { api, ApiError, type InviteView } from "../lib/api";
import { createWorkerKey, ed25519Supported, loadWorkerKey, type WorkerKey } from "../lib/workerKey";
import { hashFile, hashText, submitDelivery } from "../lib/deliver";
import { assetLabel, explorerAccount, useNetwork } from "../lib/network";

/**
 * The page the person being paid opens. No wallet, no sign-up: their
 * browser makes the one key the clause will accept, and later uses it to
 * submit delivery while a relayer pays the gas.
 */
export default function Invite() {
  const { invite: inviteId = "" } = useParams();
  const [inv, setInv] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<WorkerKey | null>(() => loadWorkerKey(inviteId));
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const { network } = useNetwork();

  const refresh = () =>
    api
      .invite(inviteId)
      .then((v) => (setInv(v), setError(null)))
      .catch((e: unknown) => setError(e instanceof ApiError ? (e.status === 404 ? "This link is not valid, or the clause was removed" : e.message) : String(e)));

  useEffect(() => {
    refresh();
    ed25519Supported().then(setSupported);
  }, [inviteId]);

  async function makeKey() {
    if (!inv) return;
    setBusy(true);
    setError(null);
    try {
      const k = await createWorkerKey(inviteId, inv.payee);
      setKey(k);
      const r = await api.bindKey(inviteId, k.publicKey, k.source);
      setInv(r.invite);
      setPending(r.pendingReason);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Past the deadline and never written on chain: accepting now would lead nowhere.
  const lapsed = !!inv && inv.status !== "written" && new Date(inv.deadline).getTime() <= Date.now();
  const settled = inv?.chainStatus === "CLAUSE_RELEASED" || inv?.chainStatus === "CLAUSE_RETURNED";

  return (
    <div className="wrap" style={{ maxWidth: 640, padding: "64px 16px 96px" }}>
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
        <LogoMark size={44} />
      </div>
      {error && <ApiDown message={`${error}.`} />}
      {inv && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <div className="eyebrow">You have been offered a job</div>
          <h1 className="h2" style={{ fontSize: 32, marginTop: 12 }}>{inv.terms}</h1>
          <div className="mini" style={{ marginTop: 20 }}>
            <div className="mini-row"><span className="faint">You receive</span><span className="mono" style={{ color: "var(--text)" }}>{inv.amount.toFixed(2)} {assetLabel(network, inv.asset)}</span></div>
            <div className="mini-row"><span className="faint">Paid to</span><span className="mono">{inv.payee}</span></div>
            <div className="mini-row"><span className="faint">From</span><span className="mono">{inv.buyer}</span></div>
            <div className="mini-row"><span className="faint">Deliver within</span><span>{settled ? "Settled" : timeLeft(inv.deadline)}</span></div>
            <div className="mini-row"><span className="faint">Status</span><StatusChip status={lapsed ? "expired" : inv.status === "written" ? "open" : "awaiting"} /></div>
          </div>

          {lapsed && (
            <div className="notice" style={{ marginTop: 22 }}>This invite expired before the clause was written, so nothing was signed and no money moved. Ask the buyer for a new link.</div>
          )}

          {inv.status === "awaiting_key" && !lapsed && (
            <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
              <p className="muted" style={{ margin: 0, fontSize: 15 }}>
                Accepting creates a key in this browser. It is the only key the clause will accept, and it can do one thing: submit your delivery. It can never move money.
              </p>
              {!supported && <div className="notice notice-red">This browser cannot create the key. Try a recent Chrome, Edge, Safari or Firefox.</div>}
              <button className="btn btn-primary" onClick={makeKey} disabled={busy || !supported}>{busy ? "Creating your key" : "Accept with a passkey"}</button>
              <p className="faint" style={{ fontSize: 13, margin: 0 }}>No wallet and no gas. If your passkey cannot derive a key, a secure random key is created and kept in this browser instead, and you will see which one was used.</p>
            </div>
          )}

          {inv.status !== "awaiting_key" && !lapsed && (
            <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
              <div className={`notice ${inv.status === "written" ? "notice-green" : "notice-violet"}`}>
                {inv.status === "written"
                  ? `The clause is on chain at ${inv.clauseAccountId}, bound to your key.`
                  : pending ?? "Your key is bound. The clause is written as soon as the buyer's side is ready."}
              </div>
              <div className="mini mono" style={{ fontSize: 12.5 }}>
                <div className="mini-row"><span className="faint">your key</span><span style={{ wordBreak: "break-all" }}>{inv.publicKey}</span></div>
                <div className="mini-row"><span className="faint">made with</span><span>{(key?.source ?? inv.keySource) === "passkey-prf" ? "your passkey" : "a secure random key in this browser"}</span></div>
              </div>
              {inv.status === "written" && !key && (
                <div className="notice">This key was created in another browser. Open the link there to deliver.</div>
              )}
              {inv.status === "written" && key && inv.clauseAccountId && (
                <Deliver clauseAccountId={inv.clauseAccountId} workerKey={key} chainStatus={inv.chainStatus ?? null} onDone={refresh} />
              )}
            </div>
          )}
        </div>
      )}
      {!inv && !error && <p className="faint" style={{ textAlign: "center" }}>Loading the job</p>}
    </div>
  );
}

function Deliver({ clauseAccountId, workerKey, chainStatus, onDone }: { clauseAccountId: string; workerKey: WorkerKey; chainStatus: string | null; onDone: () => void }) {
  const { network } = useNetwork();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ txHash: string; status: string } | null>(null);

  if (chainStatus === "CLAUSE_RELEASED") {
    return <div className="notice notice-green">Paid. The money has been released to you, and the receipt is public.</div>;
  }
  if (chainStatus === "CLAUSE_RETURNED") {
    return <div className="notice">This clause expired before delivery, so the money went back to the buyer.</div>;
  }
  if (chainStatus === "CLAUSE_DELIVERED" || chainStatus === "CLAUSE_FROZEN") {
    return <div className="notice notice-violet">Delivered. The money releases when the review window ends.</div>;
  }
  if (chainStatus !== "CLAUSE_FUNDED") {
    return <div className="notice">Waiting for the buyer to fund the clause. You can deliver as soon as it shows Funded.</div>;
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const hash = file ? await hashFile(file) : await hashText(text.trim());
      const r = await submitDelivery(clauseAccountId, workerKey, hash);
      setDone(r);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 12, marginTop: 6 }}>
      <h2 className="h3">Deliver the work</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Pick the finished file, or paste a link to it. Only its fingerprint (a sha256 hash) goes on chain; the file stays with you.</p>
      <input className="input" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {!file && <input className="input" placeholder="Or a link, e.g. https://drive.example/cut-30s.mp4" value={text} onChange={(e) => setText(e.target.value)} />}
      <button className="btn btn-primary" onClick={send} disabled={busy || (!file && !text.trim())}>{busy ? "Signing and sending" : "Submit delivery"}</button>
      <p className="faint" style={{ fontSize: 13, margin: 0 }}>Signed with your key in this browser. Clausehold pays the network fee.</p>
      {error && <div className="notice notice-red">{error}</div>}
      {done && (
        <div className="notice notice-green">
          Delivered{done.status === "CLAUSE_RELEASED" ? " and paid" : ""}. <a className="link-arrow" href={explorerAccount(network, clauseAccountId)} target="_blank" rel="noreferrer">See it on the explorer</a>
        </div>
      )}
    </div>
  );
}
