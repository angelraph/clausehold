import { describe, it, expect } from "vitest";
import { deriveDesk } from "../src/desk/view.js";
import type { AuditEntry, AuditEventType } from "../src/audit/log.js";

let seq = 0;
const e = (type: AuditEventType, payload: unknown, timestamp = new Date().toISOString()): AuditEntry => ({ seq: seq++, timestamp, type, network: "testnet", payload, prevHash: "x", hash: "y" });

const proposal = (id: string, submittedAt: string) => ({ id, agentId: "a", payee: "editor.testnet", buyer: "studio.testnet", asset: "USDC", amount: 2, terms: "t", deadline: submittedAt, challengeSecs: 0, submittedAt, mandateId: "m" });

describe("deriveDesk", () => {
  it("follows a clause from proposal to release, through its sub-account", () => {
    const p = proposal("p1", "2026-11-06T10:00:00Z");
    const rows = deriveDesk([
      e("CLAUSE_PROPOSED", { proposal: p }),
      e("VERDICT_ISSUED", { verdict: { proposalId: "p1", decision: "PASS" } }),
      e("CLAUSE_CLEARED", { proposal: p }),
      e("INVITE_OPENED", { inviteId: "i1", proposal: p }),
      e("INVITE_KEY_BOUND", { inviteId: "i1", publicKey: "ed25519:x", keySource: "passkey-prf" }),
      e("CLAUSE_CREATED", { proposalId: "p1", clauseAccountId: "r-1.clausehold.testnet", txHash: "T" }),
      e("CLAUSE_DELIVERED", { clauseAccountId: "r-1.clausehold.testnet", txHash: "T2" }),
      e("CLAUSE_RELEASED", { clauseAccountId: "r-1.clausehold.testnet", payee: "editor.testnet" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "PASS", inviteId: "i1", inviteStatus: "written", clauseAccountId: "r-1.clausehold.testnet", lastEvent: "CLAUSE_RELEASED" });
  });

  it("records which rules refused a clause", () => {
    const p = proposal("p2", "2026-11-06T11:00:00Z");
    const rows = deriveDesk([
      e("CLAUSE_PROPOSED", { proposal: p }),
      e("VERDICT_ISSUED", { verdict: { proposalId: "p2", decision: "VETO" } }),
      e("CLAUSE_REFUSED", { proposalId: "p2", rules: ["newPayeeCeiling"] }),
    ]);
    expect(rows[0]).toMatchObject({ decision: "VETO", refusedBy: ["newPayeeCeiling"], inviteId: null });
  });

  it("lists newest first and ignores events for unknown accounts", () => {
    const rows = deriveDesk([
      e("CLAUSE_PROPOSED", { proposal: proposal("old", "2026-11-01T00:00:00Z") }),
      e("CLAUSE_PROPOSED", { proposal: proposal("new", "2026-11-05T00:00:00Z") }),
      e("CLAUSE_RELEASED", { clauseAccountId: "r-9.other.testnet" }),
    ]);
    expect(rows.map((r) => r.proposal.id)).toEqual(["new", "old"]);
    expect(rows.every((r) => r.lastEvent === "CLAUSE_PROPOSED")).toBe(true);
  });
});
