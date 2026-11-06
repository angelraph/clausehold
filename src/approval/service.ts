import { randomUUID } from "node:crypto";
import { auditLog } from "../audit/log.js";
import { config } from "../config.js";
import { loadMandate } from "../mandate/store.js";
import { assessClause } from "../policy/assess.js";
import type { ClauseProposal, Verdict } from "../policy/types.js";
import { deriveApprovals, deriveKillSwitch, type ApprovalRecord, type ApprovalStatus, type KillSwitchState } from "./state.js";

export class ApprovalNotFoundError extends Error {
  constructor(public readonly approvalId: string) {
    super(`No approval found with id ${approvalId}`);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalStateError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly status: ApprovalStatus | "in-progress"
  ) {
    super(`Approval ${approvalId} is ${status} and can no longer be acted on`);
    this.name = "ApprovalStateError";
  }
}

export class SelfApprovalError extends Error {
  constructor(approver: string) {
    super(`"${approver}" proposed this clause and cannot approve it. A different approver is required.`);
    this.name = "SelfApprovalError";
  }
}

export class ApprovalBlockedError extends Error {
  constructor(public readonly verdict: Verdict) {
    const violated = verdict.reasons.filter((r) => r.outcome === "violated").map((r) => r.rule);
    super(`Approval refused: on re-check against current conditions the clause is now vetoed (${violated.join(", ")})`);
    this.name = "ApprovalBlockedError";
  }
}

export class AuditIntegrityError extends Error {
  constructor(reason: string) {
    super(`Refusing to act on an approval because the audit log failed its integrity check: ${reason}`);
    this.name = "AuditIntegrityError";
  }
}

export async function requestApproval(proposal: ClauseProposal, verdict: Verdict): Promise<{ approvalId: string; expiresAt: string }> {
  const approvalId = randomUUID();
  const expiresAt = new Date(Date.now() + config.approvalTtlMinutes * 60_000).toISOString();
  await auditLog.append("APPROVAL_REQUESTED", config.network, { approvalId, proposal, verdict, expiresAt });
  return { approvalId, expiresAt };
}

export async function listApprovals(status?: ApprovalStatus): Promise<ApprovalRecord[]> {
  const records = [...deriveApprovals(await auditLog.all()).values()];
  const filtered = status ? records.filter((r) => r.status === status) : records;
  return filtered.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export async function getApproval(approvalId: string): Promise<ApprovalRecord> {
  const record = deriveApprovals(await auditLog.all()).get(approvalId);
  if (!record) throw new ApprovalNotFoundError(approvalId);
  return record;
}

// Guards against two simultaneous approvals of the same id both passing the
// "still pending" check before either has logged its decision.
const inFlight = new Set<string>();

/** If an approval has passed its deadline but nobody has logged that yet, log it once. */
async function recordExpiryIfNeeded(approvalId: string): Promise<void> {
  const entries = await auditLog.all();
  const logged = deriveApprovals(entries, new Date(0)).get(approvalId);
  const current = deriveApprovals(entries).get(approvalId);
  if (logged?.status === "pending" && current?.status === "expired") {
    await auditLog.append("APPROVAL_EXPIRED", "n/a", { approvalId });
  }
}

export interface ApprovalOutcome {
  record: ApprovalRecord;
  verdict: Verdict;
}

export async function approve(approvalId: string, approver: string, note?: string): Promise<ApprovalOutcome> {
  if (inFlight.has(approvalId)) throw new ApprovalStateError(approvalId, "in-progress");
  inFlight.add(approvalId);
  try {
    await recordExpiryIfNeeded(approvalId);
    const record = await getApproval(approvalId);
    if (record.status !== "pending") throw new ApprovalStateError(approvalId, record.status);
    if (approver === record.proposal.agentId) throw new SelfApprovalError(approver);

    // The decision to spend is only as trustworthy as the record it is read
    // from, so check the chain before acting on anything stored in it.
    const integrity = await auditLog.verify();
    if (!integrity.ok) throw new AuditIntegrityError(`entry ${integrity.brokenAtSeq}: ${integrity.reason}`);

    // Conditions may have changed since the clause was escalated (daily cap
    // used up, payee cap reached, kill switch engaged). Evaluate again now.
    const mandate = await loadMandate(record.proposal.mandateId);
    const verdict = await assessClause(record.proposal, mandate, { recheckOfApproval: approvalId });
    if (verdict.decision === "VETO") {
      await auditLog.append("APPROVAL_REJECTED", "n/a", {
        approvalId,
        approver: "system",
        note: `Blocked at approval time by re-check: ${verdict.reasons.filter((r) => r.outcome === "violated").map((r) => r.rule).join(", ")}`,
      });
      throw new ApprovalBlockedError(verdict);
    }

    await auditLog.append("APPROVAL_GRANTED", config.network, { approvalId, approver, note });
    // Approved: the clause is now cleared to be written on chain.
    await auditLog.append("CLAUSE_CLEARED", config.network, { proposal: record.proposal, verdictId: verdict.id, approvalId, approver });
    return { record: await getApproval(approvalId), verdict };
  } finally {
    inFlight.delete(approvalId);
  }
}

export async function reject(approvalId: string, approver: string, note?: string): Promise<ApprovalRecord> {
  await recordExpiryIfNeeded(approvalId);
  const record = await getApproval(approvalId);
  if (record.status !== "pending") throw new ApprovalStateError(approvalId, record.status);
  await auditLog.append("APPROVAL_REJECTED", "n/a", { approvalId, approver, note });
  return getApproval(approvalId);
}

export async function engageKillSwitch(by: string, reason?: string): Promise<KillSwitchState> {
  await auditLog.append("KILL_SWITCH_ENGAGED", "n/a", { by, reason });
  return deriveKillSwitch(await auditLog.all());
}

export async function releaseKillSwitch(by: string): Promise<KillSwitchState> {
  await auditLog.append("KILL_SWITCH_RELEASED", "n/a", { by });
  return deriveKillSwitch(await auditLog.all());
}

export async function getKillSwitch(): Promise<KillSwitchState> {
  return deriveKillSwitch(await auditLog.all());
}
