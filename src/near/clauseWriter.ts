import { createHash } from "node:crypto";
import type { ClauseProposal } from "../policy/types.js";

/**
 * Writes a cleared clause on chain: the factory creates r-<n>, deploys the
 * clause code, and adds the worker's function-call key. The concrete
 * implementation binds to the factory contract's ABI; the API depends only
 * on this interface, so it can be tested without a chain.
 */
export interface CreateClauseParams {
  proposal: ClauseProposal;
  /** "ed25519:..." public key the editor's browser created. */
  workerPublicKey: string;
  /** sha256 hex of the plain-language terms. */
  termsHash: string;
}

export interface CreatedClause {
  clauseAccountId: string;
  txHash: string;
}

export interface ClauseWriter {
  createClause(params: CreateClauseParams): Promise<CreatedClause>;
}

export function hashTerms(terms: string): string {
  return createHash("sha256").update(terms, "utf-8").digest("hex");
}
