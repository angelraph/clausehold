import type { NetworkProfile } from "./network";

/**
 * Free, read-only calls to a NEAR RPC node straight from the browser: a
 * contract view or an account's NEAR balance. No wallet needed.
 */

const RPC: Record<NetworkProfile["id"], string> = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
};

async function query<T>(network: NetworkProfile, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(RPC[network.id], {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "clausehold", method: "query", params: { finality: "final", ...params } }),
  });
  const body = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string }; message?: string } };
  if (body.error || !body.result || body.result.error) throw new Error(body.error?.cause?.name ?? body.error?.message ?? body.result?.error ?? "RPC error");
  return body.result;
}

export async function view<T>(network: NetworkProfile, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await query<{ result: number[] }>(network, {
    request_type: "call_function",
    account_id: contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
}

/** The account's spendable NEAR, or null when the account does not exist on this network. */
export async function nearBalance(network: NetworkProfile, accountId: string): Promise<number | null> {
  try {
    const r = await query<{ amount: string }>(network, { request_type: "view_account", account_id: accountId });
    return Number(BigInt(r.amount) / 10n ** 18n) / 1e6;
  } catch {
    return null;
  }
}

/** The account's balance of the network's stablecoin, in whole units. */
export async function tokenBalance(network: NetworkProfile, accountId: string): Promise<number> {
  try {
    const raw = await view<string>(network, network.usdc, "ft_balance_of", { account_id: accountId });
    return Number(raw) / 1e6;
  } catch {
    return 0;
  }
}

export function formatNear(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

/** Base units for a 6-decimal stablecoin, without floating point drift. */
export function toBaseUnits6(amount: number): string {
  const [whole, frac = ""] = amount.toFixed(6).split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6))).toString();
}
