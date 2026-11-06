import { describe, it, expect, vi } from "vitest";
import { FactoryClauseWriter } from "../src/near/factoryWriter.js";
import { NETWORK_PROFILES } from "../src/near/network.js";
import type { ClauseProposal } from "../src/policy/types.js";

const proposal: ClauseProposal = {
  id: "11111111-1111-1111-1111-111111111111",
  agentId: "studio-agent",
  mandateId: "22222222-2222-2222-2222-222222222222",
  buyer: "studio.testnet",
  payee: "editor.testnet",
  asset: "USDC",
  amount: 2.5,
  terms: "Cut intro to 30s",
  deadline: "2026-11-10T12:00:00.000Z",
  challengeSecs: 0,
  submittedAt: "2026-11-10T11:45:00.000Z",
};

function returnValue(v: unknown) {
  return { transaction: { hash: "TXC" }, status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") } };
}

function caller(result: unknown) {
  return {
    provider: { callFunction: vi.fn(async () => "350000000000000000000000") },
    callFunctionRaw: vi.fn(async (_call: unknown) => result),
  };
}

describe("FactoryClauseWriter", () => {
  it("calls create_clause with the ABI's units and attaches the factory's deposit", async () => {
    const c = caller(returnValue("r-7.clausehold.testnet"));
    const w = new FactoryClauseWriter(c as never, NETWORK_PROFILES.testnet);
    const created = await w.createClause({ proposal, workerPublicKey: "ed25519:abc", termsHash: "f00d" });

    expect(created).toEqual({ clauseAccountId: "r-7.clausehold.testnet", txHash: "TXC" });
    expect(c.provider.callFunction).toHaveBeenCalledWith({ contractId: "clausehold.testnet", method: "create_deposit", args: {} });
    const call = c.callFunctionRaw.mock.calls[0]![0] as unknown as { contractId: string; methodName: string; args: Record<string, unknown>; deposit: bigint; gas: bigint };
    expect(call.contractId).toBe("clausehold.testnet");
    expect(call.methodName).toBe("create_clause");
    expect(call.deposit).toBe(350000000000000000000000n);
    expect(call.gas).toBe(300_000_000_000_000n);
    expect(call.args).toEqual({
      buyer: "studio.testnet",
      payee: "editor.testnet",
      worker_pk: "ed25519:abc",
      asset: "musd.clausehold.testnet",
      amount: "2500000",
      deadline: 1794312000,
      terms_hash: "f00d",
      challenge_secs: 0,
    });
  });

  it("uses native USDC on mainnet", async () => {
    const c = caller(returnValue("r-1.clausehold.near"));
    await new FactoryClauseWriter(c as never, NETWORK_PROFILES.mainnet).createClause({ proposal, workerPublicKey: "ed25519:abc", termsHash: "f00d" });
    const call = c.callFunctionRaw.mock.calls[0]![0] as unknown as { contractId: string; args: { asset: string } };
    expect(call.contractId).toBe("clausehold.near");
    expect(call.args.asset).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  });

  it("reports a refused clause with the factory's reason", async () => {
    const c = caller({ transaction: { hash: "T" }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: MANDATE:new_payee_ceiling" } } } } } });
    await expect(new FactoryClauseWriter(c as never, NETWORK_PROFILES.testnet).createClause({ proposal, workerPublicKey: "ed25519:abc", termsHash: "f" })).rejects.toThrow(/MANDATE:new_payee_ceiling/);
  });

  it("reports a failed account creation instead of a fake account", async () => {
    const c = caller(returnValue(null));
    await expect(new FactoryClauseWriter(c as never, NETWORK_PROFILES.testnet).createClause({ proposal, workerPublicKey: "ed25519:abc", termsHash: "f" })).rejects.toThrow(/refunded/);
  });

  it("refuses an asset the network does not carry", async () => {
    const c = caller(returnValue("r-1.clausehold.testnet"));
    await expect(new FactoryClauseWriter(c as never, NETWORK_PROFILES.testnet).createClause({ proposal: { ...proposal, asset: "USDT" }, workerPublicKey: "ed25519:abc", termsHash: "f" })).rejects.toThrow(/not available on testnet/);
    expect(c.callFunctionRaw).not.toHaveBeenCalled();
  });
});
