import { auditLog, type AuditEventType } from "../audit/log.js";
import { config } from "../config.js";
import type { ChainReader, ClauseState } from "../near/chain.js";

/**
 * The chain is the record; the audit log mirrors it. This reads a clause's
 * state from its own contract and appends the matching event the first time
 * the desk sees it, so the desk shows funded, delivered, released or
 * returned without trusting anything but the clause account.
 */

const EVENT_FOR: Partial<Record<ClauseState, AuditEventType>> = {
  funded: "CLAUSE_FUNDED",
  delivered: "CLAUSE_DELIVERED",
  frozen: "CLAUSE_FROZEN",
  released: "CLAUSE_RELEASED",
  returned: "CLAUSE_RETURNED",
};

const ORDER: AuditEventType[] = ["CLAUSE_CREATED", "CLAUSE_FUNDED", "CLAUSE_DELIVERED", "CLAUSE_FROZEN", "CLAUSE_RELEASED", "CLAUSE_RETURNED"];
const TERMINAL = new Set<AuditEventType>(["CLAUSE_RELEASED", "CLAUSE_RETURNED"]);

export function isTerminal(lastEvent: string): boolean {
  return TERMINAL.has(lastEvent as AuditEventType);
}

export interface SyncTarget {
  clauseAccountId: string;
  payee: string;
  buyer: string;
  lastEvent: string;
}

/** Returns the event appended, or null if the desk was already up to date. */
export async function syncClauseFromChain(chain: ChainReader, t: SyncTarget): Promise<AuditEventType | null> {
  if (isTerminal(t.lastEvent)) return null;
  const state = await chain.view<ClauseState>(t.clauseAccountId, "get_state");
  const event = EVENT_FOR[state];
  if (!event || event === t.lastEvent) return null;
  // Never step backwards: a stale read must not undo a newer event.
  if (ORDER.indexOf(event) < ORDER.indexOf(t.lastEvent as AuditEventType)) return null;
  await auditLog.append(event, config.network, { clauseAccountId: t.clauseAccountId, payee: t.payee, buyer: t.buyer, source: "chain" });
  return event;
}
