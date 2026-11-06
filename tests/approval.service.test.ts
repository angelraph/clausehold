import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({
  entries: [] as Array<{ seq: number; timestamp: string; type: string; network: string; payload: unknown; prevHash: string; hash: string }>,
  integrityOk: true,
}));

vi.mock("../src/audit/log.js", () => ({
  auditLog: {
    append: vi.fn(async (type: string, network: string, payload: unknown) => {
      const e = { seq: store.entries.length, timestamp: new Date().toISOString(), type, network, payload, prevHash: "x", hash: "y" };
      store.entries.push(e);
      return e;
    }),
    all: vi.fn(async () => [...store.entries]),
    verify: vi.fn(async () => (store.integrityOk ? { ok: true } : { ok: false, brokenAtSeq: 3, reason: "hash mismatch" })),
  },
}));

vi.mock("../src/config.js", () => ({ config: { approvalTtlMinutes: 10, network: "testnet" } }));
vi.mock("../src/mandate/store.js", () => ({ loadMandate: vi.fn(async () => ({ id: "m1", version: 1 })) }));
vi.mock("../src/policy/assess.js", () => ({ assessClause: vi.fn() }));

import {
  ApprovalBlockedError,
  ApprovalNotFoundError,
  ApprovalStateError,
  AuditIntegrityError,
  SelfApprovalError,
  approve,
  engageKillSwitch,
  getKillSwitch,
  listApprovals,
  reject,
  releaseKillSwitch,
  requestApproval,
} from "../src/approval/service.js";
import { assessClause } from "../src/policy/assess.js";
import type { ClauseProposal, Verdict } from "../src/policy/types.js";

const mockedAssess = vi.mocked(assessClause);

const proposal = { id: "p1", agentId: "agent-a", mandateId: "m1", buyer: "studio.testnet", payee: "editor.testnet", asset: "USDC", amount: 20 } as unknown as ClauseProposal;

function verdictOf(decision: Verdict["decision"], violated: string[] = []): Verdict {
  return {
    id: "v-" + decision,
    proposalId: "p1",
    decision,
    reasons: violated.map((rule) => ({ rule, outcome: "violated" as const, detail: "x" })),
    amount: 20,
    asset: "USDC",
  } as unknown as Verdict;
}

beforeEach(() => {
  store.entries.length = 0;
  store.integrityOk = true;
  mockedAssess.mockReset();
  mockedAssess.mockResolvedValue(verdictOf("ESCALATE"));
});

const typesLogged = () => store.entries.map((e) => e.type);
const clearedCount = () => typesLogged().filter((t) => t === "CLAUSE_CLEARED").length;

describe("requestApproval", () => {
  it("logs the request with an expiry ahead of now and returns its id", async () => {
    const { approvalId, expiresAt } = await requestApproval(proposal, verdictOf("ESCALATE"));
    expect(typesLogged()).toEqual(["APPROVAL_REQUESTED"]);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect((await listApprovals("pending")).map((r) => r.approvalId)).toEqual([approvalId]);
  });
});

describe("approve", () => {
  it("re-checks, records the grant with the approver, and clears the clause with the approval attached", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    const outcome = await approve(approvalId, "alice", "looks fine");

    expect(mockedAssess).toHaveBeenCalledOnce();
    const grant = store.entries.find((e) => e.type === "APPROVAL_GRANTED")!;
    expect(grant.payload).toMatchObject({ approvalId, approver: "alice", note: "looks fine" });
    const cleared = store.entries.find((e) => e.type === "CLAUSE_CLEARED")!;
    expect(cleared.payload).toMatchObject({ proposal: { id: "p1" }, approvalId, approver: "alice" });
    expect(outcome.record.status).toBe("granted");
  });

  it("refuses an unknown approval id and clears nothing", async () => {
    await expect(approve("nope", "alice")).rejects.toBeInstanceOf(ApprovalNotFoundError);
    expect(clearedCount()).toBe(0);
  });

  it("refuses to let the proposing agent approve its own clause", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    await expect(approve(approvalId, "agent-a")).rejects.toBeInstanceOf(SelfApprovalError);
    expect(clearedCount()).toBe(0);
    expect(typesLogged()).not.toContain("APPROVAL_GRANTED");
  });

  it("cannot be approved twice, so a clause is never cleared twice", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    await approve(approvalId, "alice");
    await expect(approve(approvalId, "bob")).rejects.toBeInstanceOf(ApprovalStateError);
    expect(clearedCount()).toBe(1);
  });

  it("cannot approve something already rejected", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    await reject(approvalId, "bob");
    await expect(approve(approvalId, "alice")).rejects.toBeInstanceOf(ApprovalStateError);
    expect(clearedCount()).toBe(0);
  });

  it("an approval past its deadline is expired: logged once, never cleared", async () => {
    store.entries.push({
      seq: 0,
      timestamp: new Date().toISOString(),
      type: "APPROVAL_REQUESTED",
      network: "testnet",
      payload: { approvalId: "old", proposal, verdict: verdictOf("ESCALATE"), expiresAt: new Date(Date.now() - 1000).toISOString() },
      prevHash: "x",
      hash: "y",
    });

    await expect(approve("old", "alice")).rejects.toBeInstanceOf(ApprovalStateError);
    await expect(approve("old", "alice")).rejects.toBeInstanceOf(ApprovalStateError);
    expect(typesLogged().filter((t) => t === "APPROVAL_EXPIRED")).toHaveLength(1);
    expect(clearedCount()).toBe(0);
  });

  it("blocks and records a system rejection when the re-check now vetoes it", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    mockedAssess.mockResolvedValue(verdictOf("VETO", ["perPayeeDailyCap"]));

    await expect(approve(approvalId, "alice")).rejects.toBeInstanceOf(ApprovalBlockedError);

    expect(clearedCount()).toBe(0);
    expect(typesLogged()).not.toContain("APPROVAL_GRANTED");
    const rej = store.entries.find((e) => e.type === "APPROVAL_REJECTED")!;
    expect(rej.payload).toMatchObject({ approvalId, approver: "system" });
    expect(JSON.stringify(rej.payload)).toContain("perPayeeDailyCap");
  });

  it("refuses to act when the audit log fails its integrity check", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    store.integrityOk = false;

    await expect(approve(approvalId, "alice")).rejects.toBeInstanceOf(AuditIntegrityError);
    expect(clearedCount()).toBe(0);
    expect(typesLogged()).not.toContain("APPROVAL_GRANTED");
  });

  it("two simultaneous approvals of the same id clear exactly once", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    const results = await Promise.allSettled([approve(approvalId, "alice"), approve(approvalId, "bob")]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(clearedCount()).toBe(1);
  });
});

describe("reject", () => {
  it("records who rejected and clears nothing", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    const record = await reject(approvalId, "bob", "too big");
    expect(record.status).toBe("rejected");
    expect(record.resolvedBy).toBe("bob");
    expect(clearedCount()).toBe(0);
  });

  it("cannot reject an approval that was already granted", async () => {
    const { approvalId } = await requestApproval(proposal, verdictOf("ESCALATE"));
    await approve(approvalId, "alice");
    await expect(reject(approvalId, "bob")).rejects.toBeInstanceOf(ApprovalStateError);
  });
});

describe("kill switch service", () => {
  it("engages with who and why, then releases", async () => {
    const engaged = await engageKillSwitch("alice", "unknown payee spree");
    expect(engaged).toMatchObject({ engaged: true, by: "alice", reason: "unknown payee spree" });
    expect((await getKillSwitch()).engaged).toBe(true);

    const released = await releaseKillSwitch("alice");
    expect(released.engaged).toBe(false);
    expect(typesLogged()).toEqual(["KILL_SWITCH_ENGAGED", "KILL_SWITCH_RELEASED"]);
  });
});
