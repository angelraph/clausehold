import type { Mandate } from "../../mandate/schema.js";
import type { ClauseProposal, RuleResult } from "../types.js";
import type { AuditEntry } from "../../audit/log.js";

/**
 * Rules that depend on what has already been committed. They read the audit
 * log rather than keep counters, so they cannot drift from the record. A
 * clause counts once it is CLAUSE_CLEARED: from then on it may be written
 * and funded, so its value is spoken for.
 */

interface Committed {
  at: number;
  agentId: string;
  payee: string;
  amount: number;
}

export function committedClauses(entries: AuditEntry[]): Committed[] {
  const out: Committed[] = [];
  for (const e of entries) {
    if (e.type !== "CLAUSE_CLEARED") continue;
    const p = (e.payload as { proposal: ClauseProposal }).proposal;
    out.push({ at: new Date(e.timestamp).getTime(), agentId: p.agentId, payee: p.payee, amount: p.amount });
  }
  return out;
}

/** Payees with at least one released clause. Everyone else is new. */
export function payeesWithRelease(entries: AuditEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.type !== "CLAUSE_RELEASED") continue;
    const payee = (e.payload as { payee?: string }).payee;
    if (payee) out.add(payee);
  }
  return out;
}

function startOfUtcDay(now: Date): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function checkMaxPerClause(proposal: ClauseProposal, mandate: Mandate): RuleResult {
  const max = mandate.limits.maxPerClause;
  if (proposal.amount > max) {
    return { rule: "maxPerClause", outcome: "violated", detail: `${fmt(proposal.amount)} ${proposal.asset} is over the ${fmt(max)} per-clause cap` };
  }
  return { rule: "maxPerClause", outcome: "ok", detail: `${fmt(proposal.amount)} of the ${fmt(max)} per-clause cap` };
}

export function checkDailySpendCap(proposal: ClauseProposal, mandate: Mandate, entries: AuditEntry[], now: Date): RuleResult {
  const cap = mandate.limits.dailySpendCap;
  const dayStart = startOfUtcDay(now);
  const spent = committedClauses(entries)
    .filter((c) => c.at >= dayStart)
    .reduce((sum, c) => sum + c.amount, 0);
  const projected = spent + proposal.amount;
  if (projected > cap) {
    return {
      rule: "dailySpendCap",
      outcome: "violated",
      detail: `${fmt(spent)} already committed today, and this ${fmt(proposal.amount)} would make ${fmt(projected)}, over the ${fmt(cap)} daily cap`,
    };
  }
  return { rule: "dailySpendCap", outcome: "ok", detail: `Today's total would be ${fmt(projected)} of ${fmt(cap)}` };
}

export function checkPerPayeeDailyCap(proposal: ClauseProposal, mandate: Mandate, entries: AuditEntry[], now: Date): RuleResult {
  const cap = mandate.limits.perPayeeDailyCap;
  const dayStart = startOfUtcDay(now);
  const spent = committedClauses(entries)
    .filter((c) => c.payee === proposal.payee && c.at >= dayStart)
    .reduce((sum, c) => sum + c.amount, 0);
  const projected = spent + proposal.amount;
  if (projected > cap) {
    return {
      rule: "perPayeeDailyCap",
      outcome: "violated",
      detail: `${proposal.payee} already has ${fmt(spent)} committed today, and this would make ${fmt(projected)}, over the ${fmt(cap)} per-payee daily cap`,
    };
  }
  return { rule: "perPayeeDailyCap", outcome: "ok", detail: `${proposal.payee} would be at ${fmt(projected)} of ${fmt(cap)} today` };
}

export function checkNewPayeeCeiling(proposal: ClauseProposal, mandate: Mandate, entries: AuditEntry[]): RuleResult {
  if (payeesWithRelease(entries).has(proposal.payee)) {
    return { rule: "newPayeeCeiling", outcome: "ok", detail: `${proposal.payee} has delivered before` };
  }
  const ceiling = mandate.limits.newPayeeCeiling;
  if (proposal.amount > ceiling) {
    return {
      rule: "newPayeeCeiling",
      outcome: "violated",
      detail: `${proposal.payee} has no released clause yet, so the most it may be offered is ${fmt(ceiling)}, not ${fmt(proposal.amount)}`,
    };
  }
  return { rule: "newPayeeCeiling", outcome: "ok", detail: `${proposal.payee} is new, and ${fmt(proposal.amount)} is within the ${fmt(ceiling)} ceiling` };
}

export function checkClauseRate(proposal: ClauseProposal, mandate: Mandate, entries: AuditEntry[], now: Date): RuleResult {
  const max = mandate.limits.maxClausesPerHour;
  if (max === undefined) return { rule: "maxClausesPerHour", outcome: "ok", detail: "No clause-rate limit configured" };
  const since = now.getTime() - 3_600_000;
  const recent = committedClauses(entries).filter((c) => c.agentId === proposal.agentId && c.at >= since).length;
  if (recent >= max) {
    return {
      rule: "maxClausesPerHour",
      outcome: "violated",
      detail: `${proposal.agentId} has already cleared ${recent} clause${recent === 1 ? "" : "s"} in the last hour, at the limit of ${max}`,
    };
  }
  return { rule: "maxClausesPerHour", outcome: "ok", detail: `${proposal.agentId} has cleared ${recent} of ${max} clauses in the last hour` };
}
