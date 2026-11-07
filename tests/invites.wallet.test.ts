import { describe, it, expect, vi, beforeEach } from "vitest";
import { KeyPair } from "near-api-js";

const store = vi.hoisted(() => ({
  entries: [] as Array<{ seq: number; timestamp: string; type: string; network: string; payload: unknown; prevHash: string; hash: string }>,
}));

vi.mock("../src/audit/log.js", () => ({
  auditLog: {
    append: vi.fn(async (type: string, network: string, payload: unknown) => {
      const e = { seq: store.entries.length, timestamp: new Date().toISOString(), type, network, payload, prevHash: "x", hash: "y" };
      store.entries.push(e);
      return e;
    }),
    all: vi.fn(async () => [...store.entries]),
  },
}));
vi.mock("../src/config.js", () => ({ config: { network: "testnet", factoryAccountId: "clausehold.testnet", clauseWriter: "wallet" } }));

import { bindKey, getInvite, openInvite } from "../src/invites/service.js";
import { expectedArgs, recordWalletClause, walletCreateCall } from "../src/invites/wallet.js";
import type { ChainReader } from "../src/near/chain.js";
import type { ClauseProposal } from "../src/policy/types.js";

function proposal(over: Partial<ClauseProposal> = {}): ClauseProposal {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    agentId: "studio-agent",
    mandateId: "00000000-0000-0000-0000-000000000001",
    buyer: "studio.testnet",
    payee: "editor.testnet",
    asset: "USDC",
    amount: 2,
    terms: "Cut intro.mp4 to 30 seconds",
    deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    challengeSecs: 0,
    submittedAt: new Date().toISOString(),
    ...over,
  };
}

const cleared = (p: ClauseProposal) =>
  store.entries.push({ seq: store.entries.length, timestamp: new Date().toISOString(), type: "CLAUSE_CLEARED", network: "testnet", payload: { proposal: p }, prevHash: "x", hash: "y" });

/** A chain whose clause account holds `clause`, and whose factory charges 1.97 NEAR. */
function chain(clause: Record<string, unknown> | null): ChainReader {
  return {
    view: (async (contractId: string, method: string) => {
      if (method === "create_deposit") return "1974450000000000000000000";
      if (method === "get_clause" && clause) return clause;
      throw new Error(`no ${method} on ${contractId}`);
    }) as ChainReader["view"],
    accessKeyNonce: async () => 0n,
    finalHeight: async () => 0n,
  };
}

async function boundInvite() {
  const p = proposal();
  cleared(p);
  const { inviteId } = await openInvite(p);
  const pk = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  await bindKey(inviteId, pk, "browser-random");
  return { inviteId, rec: await getInvite(inviteId) };
}

beforeEach(() => {
  store.entries.length = 0;
});

describe("the buyer's wallet writes the clause", () => {
  it("binding a key with no server writer leaves the invite for the wallet", async () => {
    const { rec } = await boundInvite();
    expect(rec.status).toBe("key_bound");
  });

  it("hands out the exact create_clause call, with the factory's deposit", async () => {
    const { inviteId, rec } = await boundInvite();
    const call = await walletCreateCall(inviteId, chain(null));
    expect(call.receiverId).toBe("clausehold.testnet");
    expect(call.methodName).toBe("create_clause");
    expect(call.deposit).toBe("1974450000000000000000000");
    expect(call.gas).toBe("300000000000000");
    expect(call.args).toMatchObject({ buyer: "studio.testnet", payee: "editor.testnet", worker_pk: rec.publicKey, asset: "musd.clausehold.testnet", amount: "2000000", challenge_secs: 0 });
  });

  it("refuses to hand out the call before the payee accepts", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    await expect(walletCreateCall(inviteId, chain(null))).rejects.toThrow(/not accepted/);
  });

  it("links a clause only after reading it on chain with every term matching", async () => {
    const { inviteId, rec } = await boundInvite();
    const onChain = { ...expectedArgs(rec), factory: "clausehold.testnet" };
    const after = await recordWalletClause(inviteId, "r-7.clausehold.testnet", "TX".padEnd(44, "a"), chain(onChain));
    expect(after.status).toBe("written");
    expect(after.clauseAccountId).toBe("r-7.clausehold.testnet");
    expect(store.entries.at(-1)?.payload).toMatchObject({ writtenBy: "buyer-wallet" });
  });

  it("refuses a clause whose terms differ, naming what differs", async () => {
    const { inviteId, rec } = await boundInvite();
    const forged = { ...expectedArgs(rec), factory: "clausehold.testnet", payee: "thief.testnet", amount: "1" };
    await expect(recordWalletClause(inviteId, "r-7.clausehold.testnet", "TX".padEnd(44, "a"), chain(forged))).rejects.toThrow(/payee, amount/);
    expect((await getInvite(inviteId)).status).toBe("key_bound");
  });

  it("refuses an account that is not one of this factory's clauses", async () => {
    const { inviteId, rec } = await boundInvite();
    const onChain = { ...expectedArgs(rec), factory: "clausehold.testnet" };
    await expect(recordWalletClause(inviteId, "r-7.evil.testnet", "TX".padEnd(44, "a"), chain(onChain))).rejects.toThrow(/not a clause/);
    await expect(recordWalletClause(inviteId, "evil.clausehold.testnet", "TX".padEnd(44, "a"), chain(onChain))).rejects.toThrow(/not a clause/);
  });

  it("refuses a clause from another factory even at a lookalike address", async () => {
    const { inviteId, rec } = await boundInvite();
    const onChain = { ...expectedArgs(rec), factory: "other.testnet" };
    await expect(recordWalletClause(inviteId, "r-7.clausehold.testnet", "TX".padEnd(44, "a"), chain(onChain))).rejects.toThrow(/factory/);
  });
});
