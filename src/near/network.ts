import { config } from "../config.js";

export type NetworkId = "testnet" | "mainnet";

export interface NetworkInfo {
  networkId: NetworkId;
  rpcUrl: string;
  explorerTx: (hash: string) => string;
  explorerAccount: (accountId: string) => string;
}

/** A stablecoin a clause can hold: its NEP-141 contract and decimals. */
export interface AssetProfile {
  symbol: string;
  contractId: string;
  decimals: number;
}

/**
 * Everything that differs between testnet and mainnet. The contracts are the
 * same on both; only these addresses change. Testnet exists so anyone, judges
 * included, can try every step without real money.
 */
export interface NetworkProfile {
  networkId: NetworkId;
  factoryAccountId: string;
  rpcUrl: string;
  explorer: string;
  /** NEAR Intents (1Click) runs on mainnet only. */
  intents: boolean;
  /** How a clause on this network is funded. */
  funding: "intents" | "direct-transfer";
  assets: AssetProfile[];
}

export const NETWORK_PROFILES: Record<NetworkId, NetworkProfile> = {
  testnet: {
    networkId: "testnet",
    factoryAccountId: "clausehold.testnet",
    rpcUrl: "https://test.rpc.fastnear.com",
    explorer: "https://testnet.nearblocks.io",
    intents: false,
    funding: "direct-transfer",
    // A mock stablecoin anyone can mint for testing, deployed beside the factory.
    assets: [{ symbol: "USDC", contractId: "musd.clausehold.testnet", decimals: 6 }],
  },
  mainnet: {
    networkId: "mainnet",
    factoryAccountId: "clausehold.near",
    rpcUrl: "https://free.rpc.fastnear.com",
    explorer: "https://nearblocks.io",
    intents: true,
    funding: "intents",
    // Native USDC on NEAR. The Intents quote still checks this against 1Click's token list.
    assets: [{ symbol: "USDC", contractId: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 }],
  },
};

/** The active network's profile, with the factory and RPC overrides from config applied. */
export function networkProfile(networkId: NetworkId = config.network): NetworkProfile {
  const base = NETWORK_PROFILES[networkId];
  return {
    ...base,
    factoryAccountId: networkId === config.network ? config.factoryAccountId : base.factoryAccountId,
    rpcUrl: networkId === config.network && config.nearRpcUrl ? config.nearRpcUrl : base.rpcUrl,
  };
}

export function assetFor(profile: NetworkProfile, symbol: string): AssetProfile {
  const a = profile.assets.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!a) throw new Error(`${symbol} is not available on ${profile.networkId}`);
  return a;
}

export function networkInfo(networkId: NetworkId = config.network, rpcOverride: string | undefined = config.nearRpcUrl): NetworkInfo {
  const p = NETWORK_PROFILES[networkId];
  return {
    networkId,
    rpcUrl: rpcOverride ?? p.rpcUrl,
    explorerTx: (hash) => `${p.explorer}/txns/${hash}`,
    explorerAccount: (accountId) => `${p.explorer}/address/${accountId}`,
  };
}

/**
 * Converts a decimal amount ("2", "0.5", 2.25) to integer base units as a
 * string, without floating-point error. Refuses more precision than the
 * token has, rather than silently rounding someone's money.
 */
export function toBaseUnits(amount: string | number, decimals: number): string {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not a non-negative decimal amount: ${s}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`${s} has more than ${decimals} decimal places`);
  const units = BigInt(whole! + frac.padEnd(decimals, "0"));
  return units.toString();
}

export function fromBaseUnits(units: string | bigint, decimals: number): string {
  const v = BigInt(units);
  if (v < 0n) throw new Error("negative amount");
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
