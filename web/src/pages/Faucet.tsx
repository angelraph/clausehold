import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatNear, nearBalance, tokenBalance } from "../lib/chain";
import { NETWORKS, useNetwork } from "../lib/network";
import { useWallet } from "../lib/wallet";
import { WalletButton } from "../components/WalletButton";

const NEAR_FAUCET = "https://near-faucet.io";
const NEAR_FAUCET_DOCS = "https://docs.near.org/getting-started/faucet";

/** Test NEAR pays gas and the clause deposit. */
const NEAR_NEEDED = 2.5;

/**
 * Everything a first-time visitor needs to try a clause on testnet, free:
 * an account, test NEAR for gas and the clause deposit, and test dollars.
 */
export default function Faucet() {
  const { network, setNetwork } = useNetwork();
  const w = useWallet();
  const [near, setNear] = useState<number | null>(null);
  const [usd, setUsd] = useState<number | null>(null);
  const [minting, setMinting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!w.accountId) return;
    const [n, u] = await Promise.all([nearBalance(network, w.accountId), tokenBalance(network, w.accountId)]);
    setNear(n ?? 0);
    setUsd(u);
  }, [w.accountId, network]);

  useEffect(() => {
    setNear(null);
    setUsd(null);
    refresh();
  }, [refresh]);

  // Coming back from the NEAR faucet tab: pick up the new balance.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  async function mint() {
    setMinting(true);
    setMsg(null);
    try {
      const r = await w.call({ receiverId: NETWORKS.testnet.usdc, methodName: "faucet", args: {}, gas: "30000000000000", deposit: "0" });
      const minted = Number(r.value ?? 0) / 1e6;
      setMsg({ ok: true, text: minted > 0 ? `Added ${minted.toFixed(2)} mUSD to your account.` : "You already hold the 100 mUSD maximum." });
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setMinting(false);
    }
  }

  if (network.id !== "testnet") {
    return (
      <div className="wrap page-head" style={{ maxWidth: 720 }}>
        <div className="eyebrow">Faucet</div>
        <h1 className="h2" style={{ marginTop: 12 }}>The faucet is for testnet</h1>
        <p className="muted" style={{ fontSize: 17 }}>
          On mainnet a clause holds real USDC from your own wallet. To try every step first with free test tokens, switch to testnet.
        </p>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => setNetwork("testnet")}>Switch to testnet</button>
      </div>
    );
  }

  const hasAccount = !!w.accountId;
  const hasNear = near !== null && near >= NEAR_NEEDED;
  const hasUsd = usd !== null && usd >= 1;

  return (
    <div className="wrap page-head" style={{ maxWidth: 760 }}>
      <div className="eyebrow">Testnet faucet</div>
      <h1 className="h2" style={{ marginTop: 12 }}>Get free test tokens</h1>
      <p className="muted" style={{ fontSize: 17, maxWidth: 600 }}>
        Three steps and you can write, fund and settle a clause with nothing real at stake. Test tokens have no value and exist only on testnet.
      </p>

      <div className="card card-pad steps" style={{ marginTop: 28 }}>
        <div className={`step ${hasAccount ? "done" : ""}`}>
          <div className="step-num">{hasAccount ? "✓" : 1}</div>
          <div>
            <h3>Connect a testnet wallet</h3>
            {hasAccount ? (
              <p className="muted">Connected as <span className="mono" style={{ color: "var(--text)" }}>{w.accountId}</span>.</p>
            ) : (
              <>
                <p className="muted">
                  Any NEAR wallet works. No account yet? Make one free in{" "}
                  <a className="link-arrow" href="https://testnet.mynearwallet.com" target="_blank" rel="noreferrer">MyNearWallet</a> or{" "}
                  <a className="link-arrow" href="https://wallet.meteorwallet.app" target="_blank" rel="noreferrer">Meteor</a>, set to testnet.
                </p>
                <WalletButton />
              </>
            )}
          </div>
        </div>

        <div className={`step ${hasNear ? "done" : ""}`}>
          <div className="step-num">{hasNear ? "✓" : 2}</div>
          <div>
            <h3>Get test NEAR</h3>
            <p className="muted">
              NEAR pays the network fee and the clause's deposit, about 2 NEAR, which keeps the clause's own account alive on chain.
              The official NEAR faucet sends it to any testnet account.
              {near !== null && <> You hold <span className="mono" style={{ color: "var(--text)" }}>{formatNear(near)} NEAR</span>.</>}
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <a className={`btn btn-sm ${hasNear ? "btn-ghost" : "btn-primary"}`} href={NEAR_FAUCET} target="_blank" rel="noreferrer">Open the NEAR faucet</a>
              {hasAccount && <button className="btn btn-ghost btn-sm" onClick={refresh}>Check my balance</button>}
              <a className="btn btn-ghost btn-sm" href={NEAR_FAUCET_DOCS} target="_blank" rel="noreferrer">How the faucet works</a>
            </div>
            {hasAccount && (
              <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>
                Paste <span className="mono">{w.accountId}</span> into the faucet, pick NEAR, and come back. This page updates when you return.
              </p>
            )}
          </div>
        </div>

        <div className={`step ${hasUsd ? "done" : ""}`}>
          <div className="step-num">{hasUsd ? "✓" : 3}</div>
          <div>
            <h3>Get 100 test dollars</h3>
            <p className="muted">
              Clauses on testnet hold mUSD, a test stablecoin with 6 decimals like USDC. One click tops your account up to 100.
              {usd !== null && <> You hold <span className="mono" style={{ color: "var(--text)" }}>{usd.toFixed(2)} mUSD</span>.</>}
            </p>
            <button className={`btn btn-sm ${hasUsd ? "btn-ghost" : "btn-primary"}`} onClick={mint} disabled={!hasAccount || minting || near === 0}>
              {minting ? "Waiting for your wallet" : "Get 100 mUSD"}
            </button>
            {hasAccount && near === 0 && <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>Get test NEAR first: the request needs a tiny network fee.</p>}
            {msg && <div className={`notice ${msg.ok ? "notice-green" : "notice-red"}`} style={{ marginTop: 12 }}>{msg.text}</div>}
          </div>
        </div>

        <div className="step">
          <div className="step-num">4</div>
          <div>
            <h3>Write your first clause</h3>
            <p className="muted">Pay a friend's testnet account, or your own second one, for a small job. The money waits in the clause until they deliver.</p>
            <Link className="btn btn-primary btn-sm" to="/desk/new">Write a clause</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
