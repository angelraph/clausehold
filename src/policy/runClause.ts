import { randomUUID } from "node:crypto";
import { loadMandate } from "../mandate/store.js";
import { ClauseProposalSchema, type ClauseProposal, type Verdict } from "./types.js";
import { assessClause } from "./assess.js";
import { requestApproval } from "../approval/service.js";
import { auditLog } from "../audit/log.js";
import { config } from "../config.js";

export interface RunClauseInput {
  agentId: string;
  mandateId: string;
  buyer: string;
  payee: string;
  asset: string;
  amount: number;
  terms: string;
  /** Minutes from now until the clause expires and returns. */
  deadlineMinutes: number;
  challengeSecs?: number;
}

export interface RunClauseResult {
  proposal: ClauseProposal;
  verdict: Verdict;
  /** True when the clause may now be written on chain. */
  cleared: boolean;
  /** Present when the verdict is ESCALATE: the pending approval a second person must act on. */
  approval?: { approvalId: string; expiresAt: string };
}

/**
 * The one pipeline every entry point (CLI, HTTP API, studio agent) runs
 * through. A PASS clears the clause to be written. A VETO refuses it before
 * anyone signs. An ESCALATE waits for a different person's approval.
 */
export async function runClause(input: RunClauseInput): Promise<RunClauseResult> {
  const mandate = await loadMandate(input.mandateId);
  const now = new Date();

  const proposal: ClauseProposal = ClauseProposalSchema.parse({
    id: randomUUID(),
    agentId: input.agentId,
    mandateId: mandate.id,
    buyer: input.buyer,
    payee: input.payee,
    asset: input.asset.toUpperCase(),
    amount: input.amount,
    terms: input.terms,
    deadline: new Date(now.getTime() + input.deadlineMinutes * 60_000).toISOString(),
    challengeSecs: input.challengeSecs ?? 0,
    submittedAt: now.toISOString(),
  });

  await auditLog.append("CLAUSE_PROPOSED", config.network, { proposal });
  const verdict = await assessClause(proposal, mandate);

  if (verdict.decision === "VETO") {
    const rules = verdict.reasons.filter((r) => r.outcome === "violated").map((r) => r.rule);
    await auditLog.append("CLAUSE_REFUSED", config.network, { proposalId: proposal.id, rules });
    return { proposal, verdict, cleared: false };
  }

  if (verdict.decision === "ESCALATE") {
    const approval = await requestApproval(proposal, verdict);
    return { proposal, verdict, cleared: false, approval };
  }

  await auditLog.append("CLAUSE_CLEARED", config.network, { proposal, verdictId: verdict.id });
  return { proposal, verdict, cleared: true };
}
