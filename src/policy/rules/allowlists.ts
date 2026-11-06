import type { Mandate } from "../../mandate/schema.js";
import type { ClauseProposal, RuleResult } from "../types.js";

export function checkAssetAllowlist(proposal: ClauseProposal, mandate: Mandate): RuleResult {
  const allowed = mandate.limits.allowedAssets.map((a) => a.toUpperCase());
  if (!allowed.includes(proposal.asset.toUpperCase())) {
    return { rule: "allowedAssets", outcome: "violated", detail: `${proposal.asset} is not in the allowed assets [${allowed.join(", ")}]` };
  }
  return { rule: "allowedAssets", outcome: "ok", detail: `${proposal.asset} is an allowed asset` };
}

export function checkPayeeAllowlist(proposal: ClauseProposal, mandate: Mandate): RuleResult {
  const { allowedPayees, blockedPayees } = mandate.limits;
  if (blockedPayees?.includes(proposal.payee)) {
    return { rule: "payeeAllowlist", outcome: "violated", detail: `${proposal.payee} is blocked by this mandate` };
  }
  if (allowedPayees && !allowedPayees.includes(proposal.payee)) {
    return { rule: "payeeAllowlist", outcome: "violated", detail: `${proposal.payee} is not in the allowed payee list` };
  }
  return { rule: "payeeAllowlist", outcome: "ok", detail: `${proposal.payee} may be paid` };
}

export function checkDeadline(proposal: ClauseProposal, mandate: Mandate, now: Date): RuleResult {
  const deadline = new Date(proposal.deadline).getTime();
  if (deadline <= now.getTime()) {
    return { rule: "deadline", outcome: "violated", detail: `The deadline ${proposal.deadline} has already passed` };
  }
  const max = mandate.limits.maxDeadlineMinutes;
  const minutes = (deadline - now.getTime()) / 60_000;
  if (max !== undefined && minutes > max) {
    return {
      rule: "maxDeadlineMinutes",
      outcome: "violated",
      detail: `The clause would stay open ${minutes.toFixed(0)} minutes, longer than the ${max} minute limit`,
    };
  }
  return { rule: "deadline", outcome: "ok", detail: `Open for ${minutes.toFixed(0)} minutes` };
}
