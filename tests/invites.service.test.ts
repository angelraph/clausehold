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
vi.mock("../src/config.js", () => ({ config: { network: "testnet" } }));

import { InviteStateError, bindKey, getInvite, openInvite, publicInviteView, writeIfReady } from "../src/invites/service.js";
import { hashTerms, type ClauseWriter } from "../src/near/clauseWriter.js";
import type { ClauseProposal } from "../src/policy/types.js";

const key = () => KeyPair.fromRandom("ed25519").getPublicKey().toString();

function proposal(over: Partial<ClauseProposal> = {}): ClauseProposal {
  return {
    id: "00000000-0000-0000-0000-0000000000p1".replace("p1", "01"),
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

function writer(): ClauseWriter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, createClause: async (p) => (calls.push(p), { clauseAccountId: "r-104.clausehold.testnet", txHash: "TXC" }) };
}

const cleared = (p: ClauseProposal) => store.entries.push({ seq: store.entries.length, timestamp: new Date().toISOString(), type: "CLAUSE_CLEARED", network: "testnet", payload: { proposal: p }, prevHash: "x", hash: "y" });

beforeEach(() => {
  store.entries.length = 0;
});

describe("invites", () => {
  it("opens with an unguessable id and waits for a key", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    expect(inviteId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const rec = await getInvite(inviteId);
    expect(rec.status).toBe("awaiting_key");
    expect(rec.cleared).toBe(true);
  });

  it("binds the editor's key, then writes the clause bound to exactly that key and the terms hash", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    const w = writer();
    const pk = key();
    const rec = await bindKey(inviteId, pk, "passkey-prf", w);
    expect(rec.status).toBe("written");
    expect(rec.clauseAccountId).toBe("r-104.clausehold.testnet");
    expect(w.calls).toEqual([{ proposal: p, workerPublicKey: pk, termsHash: hashTerms(p.terms) }]);
    expect(store.entries.map((e) => e.type)).toEqual(["CLAUSE_CLEARED", "INVITE_OPENED", "INVITE_KEY_BOUND", "CLAUSE_CREATED"]);
  });

  it("refuses a second key: the first binding wins", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    await bindKey(inviteId, key(), "passkey-prf");
    await expect(bindKey(inviteId, key(), "browser-random")).rejects.toThrow(/already bound/);
  });

  it("two simultaneous bindings: exactly one succeeds", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    const results = await Promise.allSettled([bindKey(inviteId, key(), "passkey-prf"), bindKey(inviteId, key(), "passkey-prf")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(store.entries.filter((e) => e.type === "INVITE_KEY_BOUND")).toHaveLength(1);
  });

  it("refuses a key after the clause's deadline", async () => {
    const p = proposal({ deadline: new Date(Date.now() + 1000).toISOString() });
    cleared(p);
    const { inviteId } = await openInvite(p);
    await expect(bindKey(inviteId, key(), "passkey-prf", undefined, new Date(Date.now() + 5000))).rejects.toThrow(/expired/);
  });

  it("refuses something that is not an ed25519 NEAR key", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    await expect(bindKey(inviteId, "not-a-key", "passkey-prf")).rejects.toBeInstanceOf(InviteStateError);
  });

  it("keeps the key but does not write a clause that still waits for approval, then writes it once cleared", async () => {
    const p = proposal({ amount: 20 });
    const { inviteId } = await openInvite(p);
    const w = writer();
    const rec = await bindKey(inviteId, key(), "passkey-prf", w);
    expect(rec.status).toBe("key_bound");
    expect(w.calls).toHaveLength(0);

    cleared(p);
    const after = await writeIfReady(inviteId, w);
    expect(after.status).toBe("written");
    expect(w.calls).toHaveLength(1);
  });

  it("does not write when no chain writer is configured, and says nothing false", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    const rec = await bindKey(inviteId, key(), "browser-random");
    expect(rec.status).toBe("key_bound");
    expect(publicInviteView(rec).clauseAccountId).toBeNull();
  });

  it("the public view shows the job but not the buyer's internal ids", async () => {
    const p = proposal();
    cleared(p);
    const { inviteId } = await openInvite(p);
    const v = publicInviteView(await getInvite(inviteId));
    expect(v).toMatchObject({ terms: p.terms, amount: 2, asset: "USDC", payee: "editor.testnet" });
    expect(JSON.stringify(v)).not.toContain("studio-agent");
    expect(JSON.stringify(v)).not.toContain(p.mandateId);
  });
});
