import type { AuditEntry } from "../audit/log.js";
import type { ClauseProposal, Verdict } from "../policy/types.js";
import { deriveInvites, type InviteStatus } from "../invites/service.js";

/** One row on the desk: a proposed clause and where it got to. */
export interface DeskClause {
  proposal: ClauseProposal;
  decision: Verdict["decision"];
  refusedBy: string[];
  inviteId: string | null;
  inviteStatus: InviteStatus | null;
  clauseAccountId: string | null;
  lastEvent: string;
}

const LIFECYCLE = new Set(["CLAUSE_FUNDED", "CLAUSE_DELIVERED", "CLAUSE_RELEASED", "CLAUSE_RETURNED", "CLAUSE_FROZEN"]);

/** Builds the desk from the audit log, newest first. */
export function deriveDesk(entries: AuditEntry[]): DeskClause[] {
  const rows = new Map<string, DeskClause>();
  const byAccount = new Map<string, DeskClause>();

  for (const e of entries) {
    if (e.type === "CLAUSE_PROPOSED") {
      const { proposal } = e.payload as { proposal: ClauseProposal };
      rows.set(proposal.id, { proposal, decision: "PASS", refusedBy: [], inviteId: null, inviteStatus: null, clauseAccountId: null, lastEvent: e.type });
    } else if (e.type === "VERDICT_ISSUED") {
      const { verdict } = e.payload as { verdict: Verdict };
      const row = rows.get(verdict.proposalId);
      if (row) row.decision = verdict.decision;
    } else if (e.type === "CLAUSE_REFUSED") {
      const p = e.payload as { proposalId: string; rules: string[] };
      const row = rows.get(p.proposalId);
      if (row) {
        row.refusedBy = p.rules;
        row.lastEvent = e.type;
      }
    } else if (e.type === "CLAUSE_CREATED") {
      const p = e.payload as { proposalId: string; clauseAccountId: string };
      const row = rows.get(p.proposalId);
      if (row) {
        row.clauseAccountId = p.clauseAccountId;
        row.lastEvent = e.type;
        byAccount.set(p.clauseAccountId, row);
      }
    } else if (LIFECYCLE.has(e.type)) {
      const account = (e.payload as { clauseAccountId?: string }).clauseAccountId;
      const row = account ? byAccount.get(account) : undefined;
      if (row) row.lastEvent = e.type;
    } else if (e.type === "CLAUSE_CLEARED" || e.type === "APPROVAL_REQUESTED") {
      const id = (e.payload as { proposal?: ClauseProposal }).proposal?.id;
      const row = id ? rows.get(id) : undefined;
      if (row && row.lastEvent === "CLAUSE_PROPOSED") row.lastEvent = e.type;
    }
  }

  for (const inv of deriveInvites(entries).values()) {
    const row = rows.get(inv.proposal.id);
    if (row) {
      row.inviteId = inv.inviteId;
      row.inviteStatus = inv.status;
    }
  }

  return [...rows.values()].sort((a, b) => b.proposal.submittedAt.localeCompare(a.proposal.submittedAt));
}
