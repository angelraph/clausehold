import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import { useNetwork } from "./network";

/**
 * The person's own NEAR wallet, through NEAR Connect. Any wallet the
 * connector lists works: HOT, Meteor, Intear, MyNearWallet, Nightly, OKX,
 * NEAR Mobile and others. The wallet follows the network switch, and every
 * transaction is signed and paid by the person, never by Clausehold.
 */

export interface FunctionCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** gas as a string, e.g. "30000000000000" */
  gas: string;
  /** yoctoNEAR as a string */
  deposit: string;
}

export interface CallResult {
  txHash: string;
  /** The function's return value, when the wallet reports it. */
  value: unknown;
}

interface WalletState {
  accountId: string | null;
  walletName: string | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  call: (fc: FunctionCall) => Promise<CallResult>;
}

const Ctx = createContext<WalletState | null>(null);

function lastValue(outcome: unknown): unknown {
  const status = (outcome as { status?: { SuccessValue?: string; Failure?: unknown } })?.status;
  if (status?.Failure) throw new Error(`The transaction failed on chain: ${JSON.stringify(status.Failure)}`);
  const v = status?.SuccessValue;
  if (!v) return null;
  try {
    return JSON.parse(atob(v));
  } catch {
    return null;
  }
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/reject|cancel|denied|closed/i.test(msg)) return "You closed the wallet without signing";
  return msg;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { network } = useNetwork();
  const connectorRef = useRef<NearConnector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One connector per network. Loaded on demand, so the landing page stays light.
  useEffect(() => {
    let live = true;
    setReady(false);
    setAccountId(null);
    setWalletName(null);
    (async () => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (!live) return;
      const connector = new NearConnector({
        network: network.id,
        footerBranding: null,
      });
      connectorRef.current = connector;
      connector.on("wallet:signIn", async (t) => {
        setAccountId(t.accounts[0]?.accountId ?? null);
        try {
          setWalletName((await connector.wallet()).manifest.name);
        } catch {
          setWalletName(null);
        }
      });
      connector.on("wallet:signOut", () => {
        setAccountId(null);
        setWalletName(null);
      });
      try {
        await connector.whenManifestLoaded;
        const { wallet, accounts } = await connector.getConnectedWallet();
        if (live) {
          setAccountId(accounts[0]?.accountId ?? null);
          setWalletName(wallet.manifest.name);
        }
      } catch {
        /* nobody connected on this network yet */
      }
      if (live) setReady(true);
    })().catch(() => live && setReady(true));
    return () => {
      live = false;
      connectorRef.current?.removeAllListeners();
      connectorRef.current = null;
    };
  }, [network.id]);

  const connect = useCallback(async () => {
    const c = connectorRef.current;
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      await c.whenManifestLoaded;
      await c.connect();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const c = connectorRef.current;
    if (!c) return;
    try {
      await c.disconnect();
    } finally {
      setAccountId(null);
      setWalletName(null);
    }
  }, []);

  const call = useCallback(
    async (fc: FunctionCall): Promise<CallResult> => {
      const c = connectorRef.current;
      if (!c || !accountId) throw new Error("Connect a wallet first");
      try {
        const wallet = await c.wallet();
        const outcome = await wallet.signAndSendTransaction({
          network: network.id,
          signerId: accountId,
          receiverId: fc.receiverId,
          actions: [{ type: "FunctionCall", params: { methodName: fc.methodName, args: fc.args, gas: fc.gas, deposit: fc.deposit } }],
        });
        const txHash = (outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } })?.transaction?.hash ?? (outcome as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ?? "";
        return { txHash, value: lastValue(outcome) };
      } catch (e) {
        throw new Error(friendly(e));
      }
    },
    [accountId, network.id]
  );

  return <Ctx.Provider value={{ accountId, walletName, ready, busy, error, connect, disconnect, call }}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet needs WalletProvider");
  return v;
}

export function shortAccount(id: string): string {
  if (id.length <= 22) return id;
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}
