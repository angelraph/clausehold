import type { RuleResult } from "../types.js";
import type { KillSwitchState } from "../../approval/state.js";

/**
 * Operator-level circuit breaker. While engaged, no new clause is written,
 * including one a human already approved. Clauses already on chain are not
 * touched: their funds stay under their own terms.
 */
export function checkKillSwitch(state: KillSwitchState | undefined): RuleResult {
  if (state?.engaged) {
    const who = state.by ? ` by ${state.by}` : "";
    const why = state.reason ? `: ${state.reason}` : "";
    return {
      rule: "killSwitch",
      outcome: "violated",
      detail: `New clauses are halted${who} since ${state.since}${why}. Nothing is written until it is released.`,
    };
  }
  return { rule: "killSwitch", outcome: "ok", detail: "Kill switch is not engaged" };
}
