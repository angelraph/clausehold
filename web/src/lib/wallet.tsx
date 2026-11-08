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

class TimeoutError extends Error {}

const rememberKey = (net: string) => `clausehold.wallet.${net}`;

function rememberedWallet(net: string): boolean {
  try {
    return localStorage.getItem(rememberKey(net)) === "1";
  } catch {
    return false;
  }
}

function rememberWallet(net: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(rememberKey(net), "1");
    else localStorage.removeItem(rememberKey(net));
  } catch {
    /* private mode: the wallet reconnects on the next click instead */
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new TimeoutError("timed out")), ms))]);
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

  // The wallet library loads only when it is needed: on the first click of
  // Connect wallet, or when this browser connected a wallet before. A visitor
  // who never touches the wallet runs none of its code.
  const connectorPromise = useRef<Promise<NearConnector> | null>(null);
  const liveRef = useRef(true);

  const ensureConnector = useCallback((): Promise<NearConnector> => {
    if (connectorPromise.current) return connectorPromise.current;
    const net = network.id;
    const created = import("@hot-labs/near-connect").then(({ NearConnector }) => {
      const connector = new NearConnector({ network: net, footerBranding: null });
      connector.on("wallet:signIn", async (t) => {
        if (!liveRef.current) return;
        rememberWallet(net, true);
        setAccountId(t.accounts[0]?.accountId ?? null);
        try {
          setWalletName((await connector.wallet()).manifest.name);
        } catch {
          setWalletName(null);
        }
      });
      connector.on("wallet:signOut", () => {
        rememberWallet(net, false);
        if (!liveRef.current) return;
        setAccountId(null);
        setWalletName(null);
      });
      connectorRef.current = connector;
      return connector;
    });
    created.catch(() => {
      connectorPromise.current = null;
    });
    connectorPromise.current = created;
    return created;
  }, [network.id]);

  useEffect(() => {
    liveRef.current = true;
    setReady(true);
    setAccountId(null);
    setWalletName(null);
    // Only a returning wallet user pays for loading the library on page load.
    if (rememberedWallet(network.id)) {
      ensureConnector()
        .then(async (c) => {
          await within(c.whenManifestLoaded, 15000);
          const { wallet, accounts } = await within(c.getConnectedWallet(), 8000);
          if (liveRef.current && accounts[0]) {
            setAccountId(accounts[0].accountId);
            setWalletName(wallet.manifest.name);
          } else if (!accounts[0]) {
            rememberWallet(network.id, false);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      liveRef.current = false;
      connectorRef.current?.removeAllListeners();
      connectorRef.current = null;
      connectorPromise.current = null;
    };
  }, [network.id, ensureConnector]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await within(ensureConnector(), 15000);
      await within(c.whenManifestLoaded, 15000);
      await c.connect();
    } catch (e) {
      setError(e instanceof TimeoutError ? "The wallet list did not load. Check your connection and try again." : friendly(e));
    } finally {
      setBusy(false);
    }
  }, [ensureConnector]);

  const disconnect = useCallback(async () => {
    const c = connectorRef.current;
    if (!c) return;
    try {
      await within(c.disconnect(), 8000);
    } catch {
      /* the wallet did not answer; forget it here anyway */
    } finally {
      rememberWallet(network.id, false);
      setAccountId(null);
      setWalletName(null);
    }
  }, [network.id]);

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
