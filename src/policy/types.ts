import { z } from "zod";

/**
 * What a buyer (a person, a DAO, or an agent) asks Clausehold to write: pay
 * `payee` `amount` of `asset` once `terms` are met, before `deadline`, or
 * return it to the buyer. Checked against the mandate before anyone signs.
 */
export const ClauseProposalSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().min(1),
    mandateId: z.string().uuid(),
    /** NEAR account that funds the clause and receives the return on expiry. */
    buyer: z.string().min(2),
    /** NEAR account (named or implicit) that is paid on release. */
    payee: z.string().min(2),
    asset: z.string().min(1),
    amount: z.number().positive(),
    /** Plain-language terms. Their hash is written on chain. */
    terms: z.string().min(1).max(2000),
    deadline: z.string().datetime(),
    /** Seconds after delivery during which the buyer may freeze. 0 releases at once. */
    challengeSecs: z.number().int().min(0).default(0),
    submittedAt: z.string().datetime(),
  })
  .superRefine((p, ctx) => {
    if (new Date(p.deadline).getTime() <= new Date(p.submittedAt).getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deadline"], message: "deadline must be after submittedAt" });
    }
    if (p.payee === p.buyer) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["payee"], message: "payee must differ from buyer" });
    }
  });
export type ClauseProposal = z.infer<typeof ClauseProposalSchema>;

export type RuleOutcome = "ok" | "violated" | "warning";

export interface RuleResult {
  rule: string;
  outcome: RuleOutcome;
  detail: string;
}

export type VerdictDecision = "PASS" | "VETO" | "ESCALATE";

export interface Verdict {
  id: string;
  proposalId: string;
  decision: VerdictDecision;
  reasons: RuleResult[];
  amount: number;
  asset: string;
  decidedAt: string;
  policyVersion: number;
}
