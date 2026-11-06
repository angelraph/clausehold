import type { Mandate } from "../../mandate/schema.js";
import type { ClauseProposal, RuleResult } from "../types.js";

/** Not a VETO by itself. Crossing this threshold escalates to a second person, it doesn't block. */
export function checkConfirmAbove(proposal: ClauseProposal, mandate: Mandate): RuleResult {
  const limit = mandate.limits.confirmAbove;
  if (proposal.amount > limit) {
    return {
      rule: "confirmAbove",
      outcome: "warning",
      detail: `${proposal.amount} ${proposal.asset} is above the ${limit} auto-confirm threshold and needs a second person`,
    };
  }
  return { rule: "confirmAbove", outcome: "ok", detail: `${proposal.amount} ${proposal.asset} is within the ${limit} auto-confirm threshold` };
}
