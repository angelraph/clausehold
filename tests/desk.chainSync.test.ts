import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ entries: [] as Array<{ type: string; payload: unknown }> }));
vi.mock("../src/audit/log.js", () => ({
  auditLog: { append: vi.fn(async (type: string, _n: string, payload: unknown) => (store.entries.push({ type, payload }), { type })) },
}));
vi.mock("../src/config.js", () => ({ config: { network: "testnet" } }));

import { syncClauseFromChain } from "../src/desk/chainSync.js";
import type { ChainReader } from "../src/near/chain.js";

const chain = (state: string): ChainReader => ({ view: (async () => state) as ChainReader["view"], accessKeyNonce: async () => 0n, finalHeight: async () => 0n });
const target = (lastEvent: string) => ({ clauseAccountId: "r-1.clausehold.testnet", payee: "editor.testnet", buyer: "studio.testnet", lastEvent });

beforeEach(() => {
  store.entries.length = 0;
});

describe("syncClauseFromChain", () => {
  it("records a release seen on chain, with the payee, so standing can count it", async () => {
    expect(await syncClauseFromChain(chain("released"), target("CLAUSE_DELIVERED"))).toBe("CLAUSE_RELEASED");
    expect(store.entries[0]).toEqual({ type: "CLAUSE_RELEASED", payload: { clauseAccountId: "r-1.clausehold.testnet", payee: "editor.testnet", buyer: "studio.testnet", source: "chain" } });
  });

  it("does nothing when the desk already shows the chain's state", async () => {
    expect(await syncClauseFromChain(chain("funded"), target("CLAUSE_FUNDED"))).toBeNull();
    expect(store.entries).toHaveLength(0);
  });

  it("never steps backwards on a stale read", async () => {
    expect(await syncClauseFromChain(chain("funded"), target("CLAUSE_DELIVERED"))).toBeNull();
  });

  it("does not read the chain again once a clause is released or returned", async () => {
    const view = vi.fn(async () => "funded");
    expect(await syncClauseFromChain({ ...chain("x"), view: view as ChainReader["view"] }, target("CLAUSE_RETURNED"))).toBeNull();
    expect(view).not.toHaveBeenCalled();
  });

  it("an open clause adds nothing", async () => {
    expect(await syncClauseFromChain(chain("open"), target("CLAUSE_CREATED"))).toBeNull();
  });
});
