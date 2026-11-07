import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { formatNear, nearBalance, tokenBalance } from "../lib/chain";
import { explorerAccount, useNetwork } from "../lib/network";
import { shortAccount, useWallet } from "../lib/wallet";

/** Connect, see what you hold, switch wallet, disconnect. */
export function WalletButton({ block = false }: { block?: boolean }) {
  const { network } = useNetwork();
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const [bal, setBal] = useState<{ near: number | null; usd: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !w.accountId) return;
    let live = true;
    Promise.all([nearBalance(network, w.accountId), tokenBalance(network, w.accountId)]).then(([near, usd]) => live && setBal({ near, usd }));
    return () => {
      live = false;
    };
  }, [open, w.accountId, network]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!w.accountId) {
    return (
      <button className={`btn btn-ghost btn-sm wallet-btn ${block ? "block" : ""}`} onClick={w.connect} disabled={!w.ready || w.busy}>
        <WalletIcon />
        {w.busy ? "Opening wallets" : "Connect wallet"}
      </button>
    );
  }

  const symbol = network.id === "testnet" ? "mUSD" : "USDC";
  return (
    <div className={`wallet ${block ? "block" : ""}`} ref={ref}>
      <button className="btn btn-ghost btn-sm wallet-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`dot ${network.id}`} />
        <span className="mono">{shortAccount(w.accountId)}</span>
      </button>
      {open && (
        <div className="wallet-menu" role="menu">
          <div className="wallet-menu-head">
            <div className="faint" style={{ fontSize: 12 }}>{w.walletName ?? "Wallet"} on {network.label}</div>
            <a className="mono" href={explorerAccount(network, w.accountId)} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>
              {w.accountId}
            </a>
          </div>
          <div className="wallet-menu-bal">
            <div><span className="faint">NEAR</span><span className="mono">{bal ? (bal.near === null ? "0" : formatNear(bal.near)) : "…"}</span></div>
            <div><span className="faint">{symbol}</span><span className="mono">{bal ? bal.usd.toFixed(2) : "…"}</span></div>
          </div>
          {network.id === "testnet" && (
            <Link role="menuitem" to="/faucet" onClick={() => setOpen(false)}>Get test tokens</Link>
          )}
          <Link role="menuitem" to={`/s/${encodeURIComponent(w.accountId)}`} onClick={() => setOpen(false)}>Your standing</Link>
          <button role="menuitem" onClick={async () => { setOpen(false); await w.disconnect(); await w.connect(); }}>Switch wallet</button>
          <button role="menuitem" className="danger" onClick={async () => { setOpen(false); await w.disconnect(); }}>Disconnect</button>
        </div>
      )}
    </div>
  );
}

function WalletIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1.75" y="3.75" width="12.5" height="9.5" rx="2" />
      <path d="M1.75 6.5h12.5M10.5 9.75h1.5" />
    </svg>
  );
}
