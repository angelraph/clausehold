import type { Account, JsonRpcProvider } from "near-api-js";

/** Read-only chain access the API needs. Free, no key. */
export interface ChainReader {
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  accessKeyNonce(accountId: string, publicKey: string): Promise<bigint>;
  finalHeight(): Promise<bigint>;
}

/** Calls signed by the service account. */
export interface ChainCaller {
  call(contractId: string, method: string, args: Record<string, unknown>, gas: bigint): Promise<{ txHash: string }>;
}

export type ClauseState = "open" | "funded" | "delivered" | "frozen" | "released" | "returned";

export function readerFromProvider(provider: Pick<JsonRpcProvider, "callFunction" | "viewAccessKey" | "viewBlock">): ChainReader {
  return {
    async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}) {
      return (await provider.callFunction<T & object>({ contractId, method, args })) as T;
    },
    async accessKeyNonce(accountId, publicKey) {
      const k = (await provider.viewAccessKey({ accountId, publicKey })) as unknown as { nonce: bigint | number | string };
      return BigInt(k.nonce);
    },
    async finalHeight() {
      const b = await provider.viewBlock({ finality: "final" });
      return BigInt(b.header.height);
    },
  };
}

export function callerFromAccount(account: Pick<Account, "callFunctionRaw">): ChainCaller {
  return {
    async call(contractId, methodName, args, gas) {
      const res = await account.callFunctionRaw({ contractId, methodName, args, gas, deposit: 0n });
      const failure = (res as { status?: { Failure?: unknown } }).status?.Failure;
      if (failure) throw new Error(`${methodName} failed on chain: ${JSON.stringify(failure)}`);
      return { txHash: (res as { transaction?: { hash?: string } }).transaction?.hash ?? "" };
    },
  };
}
