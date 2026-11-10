import { view } from "./chain";
import type { NetworkProfile } from "./network";

/** What the clause contract says about itself (`get_clause` on r-<n>). */
export interface ClauseView {
  id: number;
  account_id: string;
  factory: string;
  buyer: string;
  payee: string;
  worker_pk: string;
  asset: string;
  amount: string;
  /** seconds */
  deadline: number;
  terms_hash: string;
  challenge_secs: number;
  cosigner: string | null;
  state: "open" | "funded" | "delivered" | "frozen" | "released" | "returned";
  delivered_at: number | null;
  delivery_hash: string | null;
  note_hash: string | null;
  paid: string;
}

/** One settled clause, as the factory recorded it (`get_receipts`). */
export interface ChainReceipt {
  clause_id: number;
  account_id: string;
  buyer: string;
  payee: string;
  asset: string;
  amount: string;
  paid: string;
  outcome: "released" | "returned";
  terms_hash: string;
  /** seconds */
  at: number;
}

export interface RoleStats {
  open: number;
  released: number;
  returned: number;
  released_volume: string;
}

export interface Standing {
  as_payee: RoleStats;
  as_buyer: RoleStats;
}

/** The mandate as the factory stores it: token amounts in base units. */
export interface ChainMandate {
  allowed_assets: string[];
  max_per_clause: string;
  per_payee_daily_cap: string;
  daily_cap: string;
  new_payee_ceiling: string;
  paused: boolean;
  cosigner: string | null;
  creators?: string[];
}

export const readFactoryOwner = (network: NetworkProfile) => view<string>(network, network.factory, "get_owner");

export const readFactoryMandate = (network: NetworkProfile) => view<ChainMandate | null>(network, network.factory, "get_mandate");

/** The factory's own record of a clause, which outlives the clause account. */
export interface FactoryClause {
  id: number;
  account_id: string;
  buyer: string;
  payee: string;
  worker_pk: string;
  asset: string;
  amount: string;
  deadline: number;
  terms_hash: string;
  challenge_secs: number;
  status: "pending" | "live" | "released" | "returned" | "failed";
}

/** Reads `get_clause({id})` on the factory for an account named `r-<id>.<factory>`. */
export async function readFactoryClause(network: NetworkProfile, account: string): Promise<FactoryClause | null> {
  const m = /^r-(\d+)\./.exec(account);
  if (!m || !account.endsWith(`.${network.factory}`)) return null;
  return view<FactoryClause | null>(network, network.factory, "get_clause", { id: Number(m[1]) });
}

export const readClause = (network: NetworkProfile, account: string) => view<ClauseView>(network, account, "get_clause");

export const readStanding = (network: NetworkProfile, account: string) => view<Standing>(network, network.factory, "standing", { account_id: account });

export const readReceipts = (network: NetworkProfile, account: string) =>
  view<ChainReceipt[]>(network, network.factory, "get_receipts", { account_id: account, limit: 100 });

/** Token amounts on chain are in base units; both USDC and the test mUSD use 6 decimals. */
export function tokenAmount(base: string): string {
  return (Number(BigInt(base)) / 1e6).toFixed(2);
}

export function tokenSymbol(network: NetworkProfile, contractId: string): string {
  if (contractId === network.usdc) return network.id === "testnet" ? "mUSD" : "USDC";
  return contractId;
}

export function chainTime(secs: number): string {
  return new Date(secs * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
