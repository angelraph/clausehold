import { describe, it, expect } from "vitest";
import { evaluateClause } from "../src/policy/engine.js";
import type { Mandate } from "../src/mandate/schema.js";
import type { ClauseProposal } from "../src/policy/types.js";
import type { AuditEntry, AuditEventType } from "../src/audit/log.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");

const mandate: Mandate = {
  id: "00000000-0000-0000-0000-000000000001",
  version: 3,
  owner: "studio-dao.sputnik-dao.testnet",
  createdAt: "2026-11-06T00:00:00.000Z",
  factoryAccountId: "clausehold.testnet",
  naturalLanguageSource: "test",
  status: "active",
  limits: {
    maxPerClause: 25,
    dailySpendCap: 60,
    perPayeeDailyCap: 30,
    newPayeeCeiling: 10,
    confirmAbove: 15,
    allowedAssets: ["USDC", "USDT"],
    maxDeadlineMinutes: 60,
    maxClausesPerHour: 3,
  },
};

let seq = 0;
function clause(over: Partial<ClauseProposal> = {}): ClauseProposal {
  return {
    id: `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`,
    agentId: "studio-agent",
    mandateId: mandate.id,
    buyer: "studio.testnet",
    payee: "editor.testnet",
    asset: "USDC",
    amount: 5,
    terms: "Cut intro to 30s",
    deadline: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    challengeSecs: 0,
    submittedAt: NOW.toISOString(),
    ...over,
  };
}

function entry(type: AuditEventType, payload: unknown, timestamp = NOW.toISOString()): AuditEntry {
  return { seq: seq++, timestamp, type, network: "testnet", payload, prevHash: "x", hash: "y" };
}
const cleared = (p: ClauseProposal, at = NOW.toISOString()) => entry("CLAUSE_CLEARED", { proposal: p }, at);
const released = (payee: string) => entry("CLAUSE_RELEASED", { payee });

const violated = (v: ReturnType<typeof evaluateClause>) => v.reasons.filter((r) => r.outcome === "violated").map((r) => r.rule);

describe("evaluateClause", () => {
  it("passes a small clause to a new payee inside every limit", () => {
    const v = evaluateClause(clause(), mandate, { now: NOW });
    expect(v.decision).toBe("PASS");
    expect(v.amount).toBe(5);
    expect(v.policyVersion).toBe(3);
  });

  it("vetoes an asset outside the mandate", () => {
    const v = evaluateClause(clause({ asset: "NEAR" }), mandate, { now: NOW });
    expect(v.decision).toBe("VETO");
    expect(violated(v)).toEqual(["allowedAssets"]);
  });

  it("matches assets case-insensitively", () => {
    expect(evaluateClause(clause({ asset: "usdc" }), mandate, { now: NOW }).decision).toBe("PASS");
  });

  it("vetoes over the per-clause cap even for a known payee", () => {
    const v = evaluateClause(clause({ amount: 30 }), mandate, { now: NOW, entries: [released("editor.testnet")] });
    expect(violated(v)).toContain("maxPerClause");
  });

  it("vetoes a new payee above the ceiling, and allows the same amount once they have delivered", () => {
    expect(violated(evaluateClause(clause({ amount: 12 }), mandate, { now: NOW }))).toEqual(["newPayeeCeiling"]);
    const known = evaluateClause(clause({ amount: 12 }), mandate, { now: NOW, entries: [released("editor.testnet")] });
    expect(known.decision).toBe("PASS");
  });

  it("lets standing earned on chain lift the new-payee ceiling, even with no local history", () => {
    const earned = evaluateClause(clause({ amount: 12 }), mandate, { now: NOW, chainReleases: 1 });
    expect(earned.decision).toBe("PASS");
    expect(earned.reasons.find((r) => r.rule === "newPayeeCeiling")?.detail).toContain("1 released clause on chain");
    // Zero or an unanswered chain read changes nothing.
    expect(violated(evaluateClause(clause({ amount: 12 }), mandate, { now: NOW, chainReleases: 0 }))).toEqual(["newPayeeCeiling"]);
    expect(violated(evaluateClause(clause({ amount: 12 }), mandate, { now: NOW, chainReleases: null }))).toEqual(["newPayeeCeiling"]);
    // Earned standing never lifts the hard per-clause cap.
    const big = violated(evaluateClause(clause({ amount: 40 }), mandate, { now: NOW, chainReleases: 5 }));
    expect(big).toContain("maxPerClause");
    expect(big).not.toContain("newPayeeCeiling");
  });

  it("escalates above confirmAbove instead of vetoing", () => {
    const v = evaluateClause(clause({ amount: 20 }), mandate, { now: NOW, entries: [released("editor.testnet")] });
    expect(v.decision).toBe("ESCALATE");
    expect(v.reasons.find((r) => r.rule === "confirmAbove")?.outcome).toBe("warning");
  });

  it("counts clauses already cleared today against the per-payee cap", () => {
    const entries = [released("editor.testnet"), cleared(clause({ amount: 14 })), cleared(clause({ amount: 14 }))];
    const v = evaluateClause(clause({ amount: 5 }), mandate, { now: NOW, entries });
    expect(violated(v)).toEqual(["perPayeeDailyCap"]);
  });

  it("stops counting a clause that expired unwritten, or was returned, like the factory's reservation", () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    const expiredUnwritten = clause({ amount: 14, deadline: past });
    const returnedOne = clause({ amount: 14 });
    const entries = [
      released("editor.testnet"),
      cleared(expiredUnwritten),
      cleared(returnedOne),
      entry("CLAUSE_CREATED", { proposalId: returnedOne.id, clauseAccountId: "r-9.clausehold.testnet" }),
      entry("CLAUSE_RETURNED", { clauseAccountId: "r-9.clausehold.testnet" }),
      cleared(clause({ amount: 14 })),
    ];
    // Only the last 14 still counts, so 14 + 14 more is within the 30 per-payee cap.
    expect(evaluateClause(clause({ amount: 14 }), mandate, { now: NOW, entries }).decision).toBe("PASS");
  });

  it("does not count yesterday's clauses", () => {
    const yesterday = new Date(NOW.getTime() - 24 * 3_600_000).toISOString();
    const entries = [released("editor.testnet"), cleared(clause({ amount: 14 }), yesterday), cleared(clause({ amount: 14 }), yesterday)];
    expect(evaluateClause(clause({ amount: 5 }), mandate, { now: NOW, entries }).decision).toBe("PASS");
  });

  it("counts every payee against the daily cap", () => {
    const entries = [
      cleared(clause({ payee: "a.testnet", amount: 10, agentId: "x" })),
      cleared(clause({ payee: "b.testnet", amount: 10, agentId: "y" })),
      cleared(clause({ payee: "c.testnet", amount: 10, agentId: "z" })),
      cleared(clause({ payee: "d.testnet", amount: 10, agentId: "w" })),
      cleared(clause({ payee: "e.testnet", amount: 10, agentId: "v" })),
      cleared(clause({ payee: "f.testnet", amount: 8, agentId: "u" })),
    ];
    const v = evaluateClause(clause({ amount: 5 }), mandate, { now: NOW, entries });
    expect(violated(v)).toEqual(["dailySpendCap"]);
  });

  it("limits how many clauses one agent clears per hour", () => {
    const entries = [1, 2, 3].map((i) => cleared(clause({ payee: `p${i}.testnet`, amount: 1 })));
    expect(violated(evaluateClause(clause({ amount: 1 }), mandate, { now: NOW, entries }))).toEqual(["maxClausesPerHour"]);
  });

  it("vetoes a deadline past the mandate's limit, or already passed", () => {
    const tooLong = clause({ deadline: new Date(NOW.getTime() + 120 * 60_000).toISOString() });
    expect(violated(evaluateClause(tooLong, mandate, { now: NOW }))).toEqual(["maxDeadlineMinutes"]);
    const passed = clause({ deadline: new Date(NOW.getTime() - 1000).toISOString() });
    expect(violated(evaluateClause(passed, mandate, { now: NOW }))).toEqual(["deadline"]);
  });

  it("vetoes a blocked payee and one outside an allow list", () => {
    const blocked = { ...mandate, limits: { ...mandate.limits, blockedPayees: ["editor.testnet"] } };
    expect(violated(evaluateClause(clause(), blocked, { now: NOW }))).toEqual(["payeeAllowlist"]);
    const allowOnly = { ...mandate, limits: { ...mandate.limits, allowedPayees: ["someone.testnet"] } };
    expect(violated(evaluateClause(clause(), allowOnly, { now: NOW }))).toEqual(["payeeAllowlist"]);
  });

  it("vetoes everything while the kill switch is engaged", () => {
    const v = evaluateClause(clause(), mandate, { now: NOW, killSwitch: { engaged: true, by: "alice", since: NOW.toISOString() } });
    expect(violated(v)).toEqual(["killSwitch"]);
  });

  it("vetoes against a mandate that is not active", () => {
    const v = evaluateClause(clause(), { ...mandate, status: "suspended" }, { now: NOW });
    expect(violated(v)).toEqual(["mandateStatus"]);
  });

  it("a VETO wins over an ESCALATE", () => {
    const v = evaluateClause(clause({ amount: 20, asset: "DAI" }), mandate, { now: NOW, entries: [released("editor.testnet")] });
    expect(v.decision).toBe("VETO");
  });
});
