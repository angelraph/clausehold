import { config } from "../config.js";

export type NetworkId = "testnet" | "mainnet";

export interface NetworkInfo {
  networkId: NetworkId;
  rpcUrl: string;
  explorerTx: (hash: string) => string;
  explorerAccount: (accountId: string) => string;
}

const DEFAULTS: Record<NetworkId, { rpcUrl: string; explorer: string }> = {
  mainnet: { rpcUrl: "https://free.rpc.fastnear.com", explorer: "https://nearblocks.io" },
  testnet: { rpcUrl: "https://test.rpc.fastnear.com", explorer: "https://testnet.nearblocks.io" },
};

export function networkInfo(networkId: NetworkId = config.network, rpcOverride: string | undefined = config.nearRpcUrl): NetworkInfo {
  const d = DEFAULTS[networkId];
  return {
    networkId,
    rpcUrl: rpcOverride ?? d.rpcUrl,
    explorerTx: (hash) => `${d.explorer}/txns/${hash}`,
    explorerAccount: (accountId) => `${d.explorer}/address/${accountId}`,
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
