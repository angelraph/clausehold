import { userInfo } from "node:os";
import { approve, engageKillSwitch, getKillSwitch, listApprovals, reject, releaseKillSwitch } from "../../approval/service.js";
import type { ApprovalStatus } from "../../approval/state.js";

/** The CLI runs with local access to the audit log, so the operator's OS username is the default identity. */
function operator(explicit?: string): string {
  return explicit ?? userInfo().username;
}

export async function approvalsListCommand(status?: string): Promise<void> {
  const valid: ApprovalStatus[] = ["pending", "granted", "rejected", "expired"];
  if (status && !valid.includes(status as ApprovalStatus)) {
    throw new Error(`status must be one of: ${valid.join(", ")}`);
  }
  const records = await listApprovals(status as ApprovalStatus | undefined);
  if (records.length === 0) {
    console.log(status ? `No ${status} approvals.` : "No approvals recorded.");
    return;
  }
  for (const r of records) {
    const who = r.resolvedBy ? ` by ${r.resolvedBy}` : "";
    console.log(
      `${r.approvalId}  ${r.status.toUpperCase()}${who}  ${r.proposal.amount} ${r.proposal.asset} to ${r.proposal.payee}  ` +
        `from ${r.proposal.agentId}  requested ${r.requestedAt}  expires ${r.expiresAt}`
    );
  }
}

export async function approveCommand(approvalId: string, approver: string | undefined, note?: string): Promise<void> {
  const who = operator(approver);
  const { verdict } = await approve(approvalId, who, note);
  console.log(`Approved by ${who}. Re-checked against current conditions: ${verdict.decision}. The clause is cleared to be written.`);
}

export async function rejectCommand(approvalId: string, approver: string | undefined, note?: string): Promise<void> {
  const who = operator(approver);
  await reject(approvalId, who, note);
  console.log(`Rejected by ${who}. Nothing will be written.`);
}

export async function haltCommand(by: string | undefined, reason?: string): Promise<void> {
  const who = operator(by);
  await engageKillSwitch(who, reason);
  console.log(`Kill switch ENGAGED by ${who}. No new clause is written until it is released.`);
  console.log("Clauses already on chain keep their own terms: they still release on delivery or return on expiry.");
}

export async function resumeCommand(by: string | undefined): Promise<void> {
  const who = operator(by);
  await releaseKillSwitch(who);
  console.log(`Kill switch released by ${who}. Clauses are checked normally again.`);
}

export async function controlStatusCommand(): Promise<void> {
  const state = await getKillSwitch();
  if (state.engaged) {
    console.log(`Kill switch: ENGAGED since ${state.since}${state.by ? ` by ${state.by}` : ""}${state.reason ? ` (${state.reason})` : ""}`);
  } else {
    console.log("Kill switch: not engaged");
  }
  const pending = await listApprovals("pending");
  console.log(`Pending approvals: ${pending.length}`);
}
