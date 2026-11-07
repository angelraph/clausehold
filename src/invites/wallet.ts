import { auditLog } from "../audit/log.js";
import { config } from "../config.js";
import { hashTerms } from "../near/clauseWriter.js";
import { CREATE_GAS, createClauseArgs, type CreateClauseArgs } from "../near/factoryWriter.js";
import type { ChainReader } from "../near/chain.js";
import { networkProfile } from "../near/network.js";
import { getInvite, InviteStateError, type InviteRecord } from "./service.js";

/**
 * The buyer's own wallet writes the clause.
 *
 * The desk hands the browser the exact create_clause call for an invite, the
 * buyer's wallet signs it and pays the factory's deposit, and the browser
 * reports back which account was made. The desk believes none of that: it
 * reads the clause from the chain and records it only if every term matches
 * the invite. A clause written with other terms is simply never linked.
 */

export interface WalletCreateCall {
  receiverId: string;
  methodName: "create_clause";
  args: CreateClauseArgs;
  /** yoctoNEAR, as a string. */
  deposit: string;
  /** gas, as a string. */
  gas: string;
}

export function expectedArgs(rec: InviteRecord): CreateClauseArgs {
  if (!rec.publicKey) throw new InviteStateError("the payee has not accepted yet, so there is no key to bind");
  return createClauseArgs(rec.proposal, rec.publicKey, hashTerms(rec.proposal.terms), networkProfile());
}

export async function walletCreateCall(inviteId: string, chain: ChainReader): Promise<WalletCreateCall> {
  const rec = await getInvite(inviteId);
  if (rec.status === "written") throw new InviteStateError("this clause is already on chain");
  if (rec.status !== "key_bound") throw new InviteStateError("the payee has not accepted yet");
  if (!rec.cleared) throw new InviteStateError("this clause is waiting for a second person to approve it");
  const factory = networkProfile().factoryAccountId;
  const deposit = await chain.view<string>(factory, "create_deposit", {});
  return { receiverId: factory, methodName: "create_clause", args: expectedArgs(rec), deposit: String(deposit), gas: CREATE_GAS.toString() };
}

interface ClauseView {
  factory: string;
  buyer: string;
  payee: string;
  worker_pk: string;
  asset: string;
  amount: string;
  deadline: number;
  terms_hash: string;
  challenge_secs: number;
}

/** Field by field, what differs between the clause on chain and what the invite asked for. */
export function clauseMismatches(onChain: ClauseView, want: CreateClauseArgs, factory: string): string[] {
  const out: string[] = [];
  if (onChain.factory !== factory) out.push("factory");
  for (const k of ["buyer", "payee", "worker_pk", "asset", "amount", "terms_hash"] as const) {
    if (String(onChain[k]) !== String(want[k])) out.push(k);
  }
  if (Number(onChain.deadline) !== want.deadline) out.push("deadline");
  if (Number(onChain.challenge_secs) !== want.challenge_secs) out.push("challenge_secs");
  return out;
}

export async function recordWalletClause(inviteId: string, clauseAccountId: string, txHash: string, chain: ChainReader): Promise<InviteRecord> {
  const rec = await getInvite(inviteId);
  if (rec.status === "written") {
    if (rec.clauseAccountId === clauseAccountId) return rec;
    throw new InviteStateError("this invite is already linked to another clause");
  }
  if (rec.status !== "key_bound") throw new InviteStateError("the payee has not accepted yet");
  const factory = networkProfile().factoryAccountId;
  if (!clauseAccountId.endsWith(`.${factory}`) || !/^r-\d+\./.test(clauseAccountId)) {
    throw new InviteStateError(`${clauseAccountId} is not a clause of ${factory}`);
  }
  let onChain: ClauseView;
  try {
    onChain = await chain.view<ClauseView>(clauseAccountId, "get_clause", {});
  } catch {
    throw new InviteStateError(`${clauseAccountId} cannot be read on chain yet`);
  }
  const off = clauseMismatches(onChain, expectedArgs(rec), factory);
  if (off.length) throw new InviteStateError(`the clause on chain does not match this invite (${off.join(", ")})`);
  await auditLog.append("CLAUSE_CREATED", config.network, { proposalId: rec.proposal.id, clauseAccountId, txHash, workerPublicKey: rec.publicKey, writtenBy: "buyer-wallet" });
  return getInvite(inviteId);
}
