import { randomUUID } from "node:crypto";
import type { Mandate } from "../mandate/schema.js";
import type { ClauseProposal, RuleResult, Verdict, VerdictDecision } from "./types.js";
import type { AuditEntry } from "../audit/log.js";
import type { KillSwitchState } from "../approval/state.js";
import { checkKillSwitch } from "./rules/killSwitch.js";
import { checkConfirmAbove } from "./rules/confirmAboveX.js";
import { checkAssetAllowlist, checkDeadline, checkPayeeAllowlist } from "./rules/allowlists.js";
import { checkClauseRate, checkDailySpendCap, checkMaxPerClause, checkNewPayeeCeiling, checkPerPayeeDailyCap } from "./rules/spending.js";

export interface EvaluationContext {
  /** The whole audit log, for the rules that depend on what is already committed. */
  entries?: AuditEntry[];
  killSwitch?: KillSwitchState;
  now?: Date;
}

/**
 * Checks a clause against a mandate before anyone signs. Any `violated`
 * rule -> VETO (the clause is refused and never written). Otherwise any
 * `warning` -> ESCALATE (a second person must approve). Otherwise PASS.
 * The factory contract enforces the same mandate on chain; this check is
 * what lets the desk refuse before a wallet prompt and name the rule.
 */
export function evaluateClause(proposal: ClauseProposal, mandate: Mandate, context: EvaluationContext = {}): Verdict {
  const entries = context.entries ?? [];
  const now = context.now ?? new Date();

  const reasons: RuleResult[] = [
    checkKillSwitch(context.killSwitch),
    checkAssetAllowlist(proposal, mandate),
    checkPayeeAllowlist(proposal, mandate),
    checkDeadline(proposal, mandate, now),
    checkMaxPerClause(proposal, mandate),
    checkNewPayeeCeiling(proposal, mandate, entries),
    checkPerPayeeDailyCap(proposal, mandate, entries, now),
    checkDailySpendCap(proposal, mandate, entries, now),
    checkClauseRate(proposal, mandate, entries, now),
    checkConfirmAbove(proposal, mandate),
  ];
  if (mandate.status !== "active") {
    reasons.unshift({ rule: "mandateStatus", outcome: "violated", detail: `Mandate ${mandate.id} is ${mandate.status}, not active` });
  }

  let decision: VerdictDecision = "PASS";
  if (reasons.some((r) => r.outcome === "violated")) decision = "VETO";
  else if (reasons.some((r) => r.outcome === "warning")) decision = "ESCALATE";

  return {
    id: randomUUID(),
    proposalId: proposal.id,
    decision,
    reasons,
    amount: proposal.amount,
    asset: proposal.asset,
    decidedAt: now.toISOString(),
    policyVersion: mandate.version,
  };
}
