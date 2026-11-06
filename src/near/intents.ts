/**
 * NEAR Intents 1Click client, used to fund a clause from whatever chain the
 * payer already holds. Field names follow the 1Click OpenAPI spec (v0).
 *
 * How a clause is funded:
 *   1. Find the destination asset (USDC on NEAR) in GET /tokens. Never guess its id.
 *   2. POST /quote with swapType EXACT_OUTPUT and recipientType DESTINATION_CHAIN,
 *      so the solver delivers exactly the clause amount, as a NEP-141 transfer,
 *      to the clause's own sub-account. (INTENTS would credit an Intents balance
 *      instead, and the clause would never see the tokens.)
 *   3. The payer sends the origin asset to the returned depositAddress.
 *   4. Poll GET /status until SUCCESS, then the clause's sync_funding marks it Funded.
 *
 * Intents has no testnet. On testnet a clause is funded by a direct ft_transfer.
 */

export const ONE_CLICK_BASE_URL = "https://1click.chaindefuser.com/v0";

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export type SwapType = "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
export type DepositType = "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
export type RecipientType = "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";

export interface QuoteRequest {
  dry: boolean;
  swapType: SwapType;
  /** Basis points: 100 = 1%. */
  slippageTolerance: number;
  originAsset: string;
  depositType: DepositType;
  destinationAsset: string;
  /** Integer string in base units. For EXACT_OUTPUT this is the amount to deliver. */
  amount: string;
  /** Where the origin asset goes back if the swap fails. Not the clause's buyer refund. */
  refundTo: string;
  refundType: DepositType;
  recipient: string;
  recipientType: RecipientType;
  /** ISO 8601. */
  deadline: string;
  depositMode?: "SIMPLE" | "MEMO";
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export type ExecutionStatus = "KNOWN_DEPOSIT_TX" | "PENDING_DEPOSIT" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";

export interface TransactionDetails {
  hash: string;
  explorerUrl: string;
}

export interface StatusResponse {
  correlationId: string;
  quoteResponse: QuoteResponse;
  status: ExecutionStatus;
  updatedAt: string;
  swapDetails: {
    intentHashes: string[];
    nearTxHashes: string[];
    originChainTxHashes: TransactionDetails[];
    destinationChainTxHashes: TransactionDetails[];
    amountOut?: string;
    refundedAmount?: string;
    refundReason?: string;
    depositedAmount?: string;
  };
}

export const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export class OneClickError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string
  ) {
    super(`1Click ${httpStatus}: ${message}`);
    this.name = "OneClickError";
  }
}

export interface OneClickOptions {
  baseUrl?: string;
  /** Partner JWT. Optional; without it 1Click adds a 0.25% fee. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class OneClickClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OneClickOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? ONE_CLICK_BASE_URL).replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.body) headers["Content-Type"] = "application/json";
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const message = (body as { message?: string } | undefined)?.message ?? (text.slice(0, 200) || res.statusText);
      throw new OneClickError(res.status, message);
    }
    return body as T;
  }

  tokens(): Promise<OneClickToken[]> {
    return this.request<OneClickToken[]>("/tokens");
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("/quote", { method: "POST", body: JSON.stringify(req) });
  }

  status(depositAddress: string, depositMemo?: string): Promise<StatusResponse> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set("depositMemo", depositMemo);
    return this.request<StatusResponse>(`/status?${q.toString()}`);
  }

  /** Optional: tells 1Click about the deposit so it starts sooner. */
  submitDeposit(body: { txHash: string; depositAddress: string; nearSenderAccount?: string; memo?: string }): Promise<StatusResponse> {
    return this.request<StatusResponse>("/deposit/submit", { method: "POST", body: JSON.stringify(body) });
  }
}

/** Finds a token by chain and symbol. Throws if there is not exactly one, rather than picking a lookalike. */
export function findToken(tokens: OneClickToken[], blockchain: string, symbol: string): OneClickToken {
  const matches = tokens.filter((t) => t.blockchain.toLowerCase() === blockchain.toLowerCase() && t.symbol.toUpperCase() === symbol.toUpperCase());
  if (matches.length === 0) throw new Error(`1Click lists no ${symbol} on ${blockchain}`);
  if (matches.length > 1) {
    throw new Error(`1Click lists ${matches.length} tokens named ${symbol} on ${blockchain} (${matches.map((m) => m.assetId).join(", ")}); pick one by assetId`);
  }
  return matches[0]!;
}

/** "nep141:<contract>" -> "<contract>". The NEP-141 contract the clause holds. */
export function nep141ContractId(assetId: string): string {
  if (!assetId.startsWith("nep141:")) throw new Error(`${assetId} is not a NEP-141 asset on NEAR`);
  return assetId.slice("nep141:".length);
}

export interface ClauseFundingParams {
  /** The asset the payer holds, e.g. USDC on Base, by 1Click assetId. */
  originAsset: string;
  /** USDC on NEAR, by 1Click assetId (from findToken). */
  destinationAsset: string;
  /** The clause amount in the destination asset's base units. */
  amountBase: string;
  /** The clause's sub-account, e.g. r-104.clausehold.near. */
  clauseAccountId: string;
  /** The payer's address on the origin chain, for a failed swap. */
  refundTo: string;
  /** When the quote's deposit address stops accepting funds. */
  deadline: Date;
  dry: boolean;
  slippageBps?: number;
}

export function buildClauseFundingQuote(p: ClauseFundingParams): QuoteRequest {
  if (!/^\d+$/.test(p.amountBase) || BigInt(p.amountBase) <= 0n) throw new Error(`amountBase must be a positive integer string, got ${p.amountBase}`);
  return {
    dry: p.dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: p.slippageBps ?? 100,
    originAsset: p.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: p.destinationAsset,
    amount: p.amountBase,
    refundTo: p.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: p.clauseAccountId,
    recipientType: "DESTINATION_CHAIN",
    deadline: p.deadline.toISOString(),
  };
}

/**
 * Refuses a quote that would leave the clause short. With EXACT_OUTPUT the
 * delivered amount should equal the request, but this is the last check
 * before a deposit address is shown to a payer, so it does not assume.
 */
export function assertQuoteFundsClause(res: QuoteResponse, req: QuoteRequest): void {
  const out = BigInt(res.quote.amountOut);
  const minOut = BigInt(res.quote.minAmountOut);
  const need = BigInt(req.amount);
  if (out < need || minOut < need) {
    throw new Error(`Quote delivers ${res.quote.amountOut} (min ${res.quote.minAmountOut}), less than the clause amount ${req.amount}; refusing to show a deposit address`);
  }
  if (res.quoteRequest.recipient !== req.recipient || res.quoteRequest.recipientType !== "DESTINATION_CHAIN") {
    throw new Error(`Quote is addressed to ${res.quoteRequest.recipient} (${res.quoteRequest.recipientType}), not the clause account ${req.recipient}`);
  }
  if (!req.dry && !res.quote.depositAddress) {
    throw new Error("Quote has no deposit address");
  }
}

export interface WaitOptions {
  pollMs?: number;
  timeoutMs?: number;
  onUpdate?: (s: StatusResponse) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Polls until SUCCESS, REFUNDED or FAILED, or until the timeout. */
export async function waitForFunding(client: OneClickClient, depositAddress: string, opts: WaitOptions = {}): Promise<StatusResponse> {
  const pollMs = opts.pollMs ?? 5000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (;;) {
    const s = await client.status(depositAddress);
    opts.onUpdate?.(s);
    if (TERMINAL_STATUSES.has(s.status)) return s;
    if (Date.now() >= deadline) throw new Error(`Funding for ${depositAddress} still ${s.status} after timeout`);
    await sleep(pollMs);
  }
}
