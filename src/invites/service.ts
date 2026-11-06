import { randomBytes } from "node:crypto";
import { PublicKey } from "near-api-js";
import { auditLog, type AuditEntry } from "../audit/log.js";
import { config } from "../config.js";
import type { ClauseProposal } from "../policy/types.js";
import { hashTerms, type ClauseWriter } from "../near/clauseWriter.js";

/**
 * An invite is how the editor's key exists before the clause does.
 *
 *   1. The buyer's agent proposes a clause. If the mandate clears it (or a
 *      second person later approves it), an invite is opened.
 *   2. The editor opens the invite link. Their browser creates an ed25519
 *      key (from a passkey when the browser supports it) and sends back only
 *      the public half.
 *   3. The clause is written on chain bound to that key. It is the only key
 *      on the clause account and can call nothing but submit_delivery.
 *
 * The invite id is the capability: whoever holds the link can bind the key.
 * It can only ever deliver work to the fixed payee, never redirect money.
 * State is derived from the audit log, like approvals.
 */

export type InviteStatus = "awaiting_key" | "key_bound" | "written";
export type KeySource = "passkey-prf" | "browser-random";

export interface InviteRecord {
  inviteId: string;
  proposal: ClauseProposal;
  openedAt: string;
  status: InviteStatus;
  publicKey?: string;
  keySource?: KeySource;
  clauseAccountId?: string;
  createTxHash?: string;
  cleared: boolean;
}

export class InviteNotFoundError extends Error {
  constructor(id: string) {
    super(`No invite ${id}`);
    this.name = "InviteNotFoundError";
  }
}

export class InviteStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteStateError";
  }
}

export function deriveInvites(entries: AuditEntry[]): Map<string, InviteRecord> {
  const invites = new Map<string, InviteRecord>();
  const byProposal = new Map<string, InviteRecord>();
  const clearedProposals = new Set<string>();

  for (const e of entries) {
    if (e.type === "CLAUSE_CLEARED") {
      const id = (e.payload as { proposal: ClauseProposal }).proposal.id;
      clearedProposals.add(id);
      const inv = byProposal.get(id);
      if (inv) inv.cleared = true;
    } else if (e.type === "INVITE_OPENED") {
      const p = e.payload as { inviteId: string; proposal: ClauseProposal };
      const rec: InviteRecord = { inviteId: p.inviteId, proposal: p.proposal, openedAt: e.timestamp, status: "awaiting_key", cleared: clearedProposals.has(p.proposal.id) };
      invites.set(p.inviteId, rec);
      byProposal.set(p.proposal.id, rec);
    } else if (e.type === "INVITE_KEY_BOUND") {
      const p = e.payload as { inviteId: string; publicKey: string; keySource: KeySource };
      const rec = invites.get(p.inviteId);
      if (rec && rec.status === "awaiting_key") {
        rec.status = "key_bound";
        rec.publicKey = p.publicKey;
        rec.keySource = p.keySource;
      }
    } else if (e.type === "CLAUSE_CREATED") {
      const p = e.payload as { proposalId: string; clauseAccountId: string; txHash: string };
      const rec = byProposal.get(p.proposalId);
      if (rec && rec.status === "key_bound") {
        rec.status = "written";
        rec.clauseAccountId = p.clauseAccountId;
        rec.createTxHash = p.txHash;
      }
    }
  }
  return invites;
}

export async function openInvite(proposal: ClauseProposal): Promise<{ inviteId: string }> {
  const inviteId = randomBytes(16).toString("base64url");
  await auditLog.append("INVITE_OPENED", "n/a", { inviteId, proposal });
  return { inviteId };
}

export async function getInvite(inviteId: string): Promise<InviteRecord> {
  const rec = deriveInvites(await auditLog.all()).get(inviteId);
  if (!rec) throw new InviteNotFoundError(inviteId);
  return rec;
}

export async function findInviteByProposal(proposalId: string): Promise<InviteRecord | undefined> {
  for (const rec of deriveInvites(await auditLog.all()).values()) if (rec.proposal.id === proposalId) return rec;
  return undefined;
}

function parseWorkerKey(publicKey: string): string {
  let pk: PublicKey;
  try {
    pk = PublicKey.fromString(publicKey);
  } catch {
    throw new InviteStateError("publicKey is not a valid NEAR public key");
  }
  if (!pk.toString().startsWith("ed25519:")) throw new InviteStateError("the worker key must be ed25519");
  return pk.toString();
}

const inFlight = new Set<string>();

/**
 * Binds the editor's public key to the invite once, then writes the clause
 * on chain if it is cleared and a writer is configured. A clause waiting on
 * a second person's approval keeps the key and is written by `writeIfReady`
 * once approved.
 */
export async function bindKey(inviteId: string, publicKey: string, keySource: KeySource, writer?: ClauseWriter, now = new Date()): Promise<InviteRecord> {
  if (inFlight.has(inviteId)) throw new InviteStateError("this invite is already being bound");
  inFlight.add(inviteId);
  try {
    const rec = await getInvite(inviteId);
    if (rec.status !== "awaiting_key") throw new InviteStateError("a key is already bound to this invite");
    if (new Date(rec.proposal.deadline).getTime() <= now.getTime()) throw new InviteStateError("this invite's clause has already expired");
    const key = parseWorkerKey(publicKey);
    await auditLog.append("INVITE_KEY_BOUND", "n/a", { inviteId, publicKey: key, keySource });
    return writeIfReady(inviteId, writer);
  } finally {
    inFlight.delete(inviteId);
  }
}

export async function writeIfReady(inviteId: string, writer?: ClauseWriter): Promise<InviteRecord> {
  const rec = await getInvite(inviteId);
  if (rec.status !== "key_bound" || !rec.cleared || !writer) return rec;
  const created = await writer.createClause({ proposal: rec.proposal, workerPublicKey: rec.publicKey!, termsHash: hashTerms(rec.proposal.terms) });
  await auditLog.append("CLAUSE_CREATED", config.network, { proposalId: rec.proposal.id, clauseAccountId: created.clauseAccountId, txHash: created.txHash, workerPublicKey: rec.publicKey });
  return getInvite(inviteId);
}

/** What the editor's page may see: the job, not the buyer's internal ids. */
export function publicInviteView(rec: InviteRecord) {
  const p = rec.proposal;
  return {
    inviteId: rec.inviteId,
    status: rec.status,
    cleared: rec.cleared,
    terms: p.terms,
    amount: p.amount,
    asset: p.asset,
    payee: p.payee,
    buyer: p.buyer,
    deadline: p.deadline,
    challengeSecs: p.challengeSecs,
    publicKey: rec.publicKey ?? null,
    keySource: rec.keySource ?? null,
    clauseAccountId: rec.clauseAccountId ?? null,
    createTxHash: rec.createTxHash ?? null,
  };
}
