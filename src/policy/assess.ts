import type { Mandate } from "../mandate/schema.js";
import type { ClauseProposal, Verdict } from "./types.js";
import { evaluateClause } from "./engine.js";
import { deriveKillSwitch } from "../approval/state.js";
import { auditLog } from "../audit/log.js";
import { config } from "../config.js";

/**
 * Evaluates a clause against the mandate, what is already committed and the
 * kill switch, then records the verdict. Used on first submission and again
 * when a human approval is about to be acted on.
 */
export async function assessClause(proposal: ClauseProposal, mandate: Mandate, extra: Record<string, unknown> = {}): Promise<Verdict> {
  const entries = await auditLog.all();
  const verdict = evaluateClause(proposal, mandate, { entries, killSwitch: deriveKillSwitch(entries) });
  await auditLog.append("VERDICT_ISSUED", config.network, { verdict, ...extra });
  return verdict;
}
