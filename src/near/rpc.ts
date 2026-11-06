import { JsonRpcProvider } from "near-api-js";
import { networkInfo, type NetworkInfo } from "./network.js";

let cached: { url: string; provider: JsonRpcProvider } | undefined;

export function getProvider(info: NetworkInfo = networkInfo()): JsonRpcProvider {
  if (!cached || cached.url !== info.rpcUrl) {
    cached = { url: info.rpcUrl, provider: new JsonRpcProvider({ url: info.rpcUrl }) };
  }
  return cached.provider;
}

/** A read-only contract call. Costs nothing and needs no key. */
export async function viewCall<T>(contractId: string, method: string, args: Record<string, unknown> = {}, provider = getProvider()): Promise<T> {
  return (await provider.callFunction<T & object>({ contractId, method, args })) as T;
}

/** NEP-141 balance in base units. */
export async function ftBalanceOf(tokenContractId: string, accountId: string, provider = getProvider()): Promise<bigint> {
  const raw = await viewCall<string>(tokenContractId, "ft_balance_of", { account_id: accountId }, provider);
  return BigInt(raw ?? "0");
}
