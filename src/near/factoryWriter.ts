import { getTransactionLastResult } from "near-api-js";
import type { Account } from "near-api-js";
import type { ClauseWriter, CreateClauseParams, CreatedClause } from "./clauseWriter.js";
import { assetFor, toBaseUnits, type NetworkProfile } from "./network.js";
import type { ClauseProposal } from "../policy/types.js";

/** 300 Tgas: create_clause deploys the clause code and adds its key in one go. */
export const CREATE_GAS = 300_000_000_000_000n;

export interface CreateClauseArgs {
  buyer: string;
  payee: string;
  worker_pk: string;
  asset: string;
  amount: string;
  deadline: number;
  terms_hash: string;
  challenge_secs: number;
}

/** The exact create_clause arguments for a proposal, whoever signs them: the service account or the buyer's own wallet. */
export function createClauseArgs(proposal: ClauseProposal, workerPublicKey: string, termsHash: string, profile: NetworkProfile): CreateClauseArgs {
  const asset = assetFor(profile, proposal.asset);
  return {
    buyer: proposal.buyer,
    payee: proposal.payee,
    worker_pk: workerPublicKey,
    asset: asset.contractId,
    amount: toBaseUnits(proposal.amount, asset.decimals),
    deadline: Math.floor(new Date(proposal.deadline).getTime() / 1000),
    terms_hash: termsHash,
    challenge_secs: proposal.challengeSecs,
  };
}

export class ClauseCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClauseCreateError";
  }
}

type Caller = Pick<Account, "callFunctionRaw" | "provider">;

/**
 * Writes a cleared clause through the factory contract (see contracts/ABI.md).
 * The service account signs and pays the factory's create_deposit, which
 * covers the clause account's storage. Amounts go on chain in base units,
 * the deadline in unix seconds, and the asset as its token contract id.
 */
export class FactoryClauseWriter implements ClauseWriter {
  constructor(
    private readonly caller: Caller,
    private readonly profile: NetworkProfile
  ) {}

  async createClause({ proposal, workerPublicKey, termsHash }: CreateClauseParams): Promise<CreatedClause> {
    const factory = this.profile.factoryAccountId;
    const deposit = await this.caller.provider.callFunction<string>({ contractId: factory, method: "create_deposit", args: {} });
    if (!deposit) throw new ClauseCreateError("The factory did not report its create_deposit");

    const args = createClauseArgs(proposal, workerPublicKey, termsHash, this.profile);

    const res = await this.caller.callFunctionRaw({ contractId: factory, methodName: "create_clause", args, deposit: BigInt(deposit), gas: CREATE_GAS });
    const failure = (res as { status?: { Failure?: unknown } }).status?.Failure;
    if (failure) throw new ClauseCreateError(`The factory refused the clause: ${JSON.stringify(failure)}`);
    const account = getTransactionLastResult(res as never) as string | null;
    if (!account) throw new ClauseCreateError("The factory could not create the clause account; its deposit was refunded");
    return { clauseAccountId: account, txHash: (res as { transaction?: { hash?: string } }).transaction?.hash ?? "" };
  }
}
