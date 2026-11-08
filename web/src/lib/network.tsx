import { createContext, useContext, useState, type ReactNode } from "react";

export type NetworkId = "testnet" | "mainnet";

export interface NetworkProfile {
  id: NetworkId;
  label: string;
  factory: string;
  explorer: string;
  /** NEAR Intents (1Click) runs on mainnet only. */
  intents: boolean;
  usdc: string;
  /** The desk API for this network, set at build time. */
  apiBase: string;
}

const env = import.meta.env as Record<string, string | undefined>;

export const NETWORKS: Record<NetworkId, NetworkProfile> = {
  testnet: {
    id: "testnet",
    label: "Testnet",
    factory: "clausehold.testnet",
    explorer: "https://testnet.nearblocks.io",
    intents: false,
    usdc: "musd.clausehold.testnet",
    apiBase: env.VITE_API_BASE_TESTNET ?? env.VITE_API_BASE ?? "http://localhost:4477",
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    factory: "clausehold.near",
    explorer: "https://nearblocks.io",
    intents: true,
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    apiBase: env.VITE_API_BASE_MAINNET ?? "http://localhost:4478",
  },
};

/** On testnet the USDC slot is filled by mUSD, the free test token, so say that. */
export function assetLabel(network: NetworkProfile, asset: string): string {
  return network.id === "testnet" && asset === "USDC" ? "mUSD" : asset;
}

const KEY = "clausehold.network";

/** The network this browser last chose. Testnet unless the person switched, so anyone can try it without real money. */
export function currentNetwork(): NetworkId {
  try {
    return localStorage.getItem(KEY) === "mainnet" ? "mainnet" : "testnet";
  } catch {
    return "testnet";
  }
}

const Ctx = createContext<{ network: NetworkProfile; setNetwork: (id: NetworkId) => void }>({
  network: NETWORKS.testnet,
  setNetwork: () => {},
});

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<NetworkId>(currentNetwork());
  const setNetwork = (next: NetworkId) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    setId(next);
  };
  return <Ctx.Provider value={{ network: NETWORKS[id], setNetwork }}>{children}</Ctx.Provider>;
}

export const useNetwork = () => useContext(Ctx);

export function explorerAccount(n: NetworkProfile, account: string): string {
  return `${n.explorer}/address/${encodeURIComponent(account)}`;
}

export function NetworkSwitch() {
  const { network, setNetwork } = useNetwork();
  return (
    <div className="netswitch" role="radiogroup" aria-label="Network">
      {(["testnet", "mainnet"] as const).map((id) => (
        <button key={id} role="radio" aria-checked={network.id === id} className={network.id === id ? "on" : ""} onClick={() => setNetwork(id)}>
          <span className={`dot ${id}`} />
          {NETWORKS[id].label}
        </button>
      ))}
    </div>
  );
}
