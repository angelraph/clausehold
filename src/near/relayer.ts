import { createHash } from "node:crypto";
import { deserialize } from "borsh";
import { DelegateAction, encodeDelegateAction, KeyType, PublicKey, SCHEMA, Signature } from "near-api-js";
// SignedDelegate is declared in near-api-js's types but not exported at
// runtime (7.3.1). It is a plain { delegateAction, signature } holder, and
// relayMetaTransaction rebuilds its own, so a plain object is equivalent.
import type { Account, JsonRpcProvider, SignedDelegate } from "near-api-js";

/**
 * Gasless delivery (NEP-366 meta-transactions).
 *
 * The editor's browser holds one function-call key on the clause account,
 * limited to `submit_delivery`. It signs a delegate action and sends it here;
 * the relayer wraps it in a transaction and pays the gas. On chain the call
 * runs with predecessor = the clause account, which is what the contract
 * checks, and the protocol checks that the signing key may call that method.
 *
 * The relayer spends its own NEAR on every delegate it submits, so it refuses
 * anything that is not exactly a well-signed, unexpired delivery to a clause
 * account under our factory, before any gas is spent.
 */

export const DELIVERY_METHOD = "submit_delivery";
/** 50 Tgas is ample for submit_delivery, including an immediate release. */
export const DEFAULT_MAX_GAS = 300_000_000_000_000n;

export class RelayRefusedError extends Error {
  constructor(reason: string) {
    super(`Relay refused: ${reason}`);
    this.name = "RelayRefusedError";
  }
}

interface DecodedFunctionCall {
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}

interface DecodedSignedDelegate {
  delegateAction: {
    senderId: string;
    receiverId: string;
    actions: Array<Record<string, unknown>>;
    nonce: bigint;
    maxBlockHeight: bigint;
    publicKey: Record<string, { data: Uint8Array | number[] }>;
  };
  signature: Record<string, { data: Uint8Array | number[] }>;
}

function enumKeyData(value: Record<string, { data: Uint8Array | number[] }>, what: string): { variant: string; data: Uint8Array } {
  const keys = Object.keys(value).filter((k) => k !== "enum");
  if (keys.length !== 1) throw new RelayRefusedError(`malformed ${what}`);
  const variant = keys[0]!;
  return { variant, data: Uint8Array.from(value[variant]!.data) };
}

export interface DecodedDelivery {
  signedDelegate: SignedDelegate;
  senderId: string;
  publicKey: PublicKey;
  nonce: bigint;
  maxBlockHeight: bigint;
  args: Record<string, unknown>;
  gas: bigint;
  /** sha256 of the NEP-461-prefixed delegate action: what the key signed. */
  delegateHash: Uint8Array;
}

/** Decodes a base64 borsh SignedDelegate and rebuilds the library's classes from it. */
export function decodeSignedDelegate(base64: string): DecodedDelivery {
  let raw: DecodedSignedDelegate;
  try {
    raw = deserialize(SCHEMA.SignedDelegate, Buffer.from(base64, "base64")) as DecodedSignedDelegate;
  } catch (err) {
    throw new RelayRefusedError(`not a valid SignedDelegate (${err instanceof Error ? err.message : String(err)})`);
  }

  const pk = enumKeyData(raw.delegateAction.publicKey, "public key");
  const sig = enumKeyData(raw.signature, "signature");
  if (pk.variant !== "ed25519Key" || sig.variant !== "ed25519Signature") {
    throw new RelayRefusedError("only ed25519 worker keys are accepted");
  }
  const publicKey = new PublicKey({ keyType: KeyType.ED25519, data: pk.data });
  const signature = new Signature({ keyType: KeyType.ED25519, data: sig.data });

  const da = raw.delegateAction;
  if (da.actions.length !== 1) throw new RelayRefusedError(`expected exactly one action, got ${da.actions.length}`);
  const action = da.actions[0]!;
  const fc = action.functionCall as DecodedFunctionCall | undefined;
  if (!fc || Object.keys(action).filter((k) => k !== "enum").length !== 1) {
    throw new RelayRefusedError("the only allowed action is a function call");
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(Buffer.from(fc.args).toString("utf-8")) as Record<string, unknown>;
  } catch {
    throw new RelayRefusedError("function call args are not JSON");
  }

  const delegateAction = new DelegateAction({
    senderId: da.senderId,
    receiverId: da.receiverId,
    actions: da.actions as never,
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
    publicKey,
  });
  if (fc.methodName !== DELIVERY_METHOD) throw new RelayRefusedError(`method must be ${DELIVERY_METHOD}, got ${fc.methodName}`);
  if (BigInt(fc.deposit) !== 0n) throw new RelayRefusedError("a delivery must attach no deposit");

  const delegateHash = new Uint8Array(createHash("sha256").update(encodeDelegateAction(delegateAction)).digest());
  return {
    signedDelegate: { delegateAction, signature } as SignedDelegate,
    senderId: da.senderId,
    publicKey,
    nonce: BigInt(da.nonce),
    maxBlockHeight: BigInt(da.maxBlockHeight),
    args,
    gas: BigInt(fc.gas),
    delegateHash,
  };
}

/** True when `accountId` is a clause sub-account of the factory: r-<n>.<factory>. */
export function isClauseAccount(accountId: string, factoryAccountId: string): boolean {
  const suffix = `.${factoryAccountId}`;
  if (!accountId.endsWith(suffix)) return false;
  return /^r-\d+$/.test(accountId.slice(0, -suffix.length));
}

export interface StaticCheckOptions {
  factoryAccountId: string;
  maxGas?: bigint;
}

/** Everything that can be checked without the network. */
export function checkDeliveryStatic(d: DecodedDelivery, opts: StaticCheckOptions): void {
  const da = d.signedDelegate.delegateAction;
  if (!isClauseAccount(da.senderId, opts.factoryAccountId)) {
    throw new RelayRefusedError(`${da.senderId} is not a clause account under ${opts.factoryAccountId}`);
  }
  if (da.receiverId !== da.senderId) throw new RelayRefusedError("a delivery must call the clause account itself");
  if (d.gas > (opts.maxGas ?? DEFAULT_MAX_GAS)) throw new RelayRefusedError(`gas ${d.gas} is above the relay limit`);
  if (typeof d.args.hash !== "string" || d.args.hash.length === 0) throw new RelayRefusedError("submit_delivery needs a non-empty hash");
  if (!d.publicKey.verify(d.delegateHash, d.signedDelegate.signature.data)) {
    throw new RelayRefusedError("the signature does not match the delegate action and key");
  }
}

interface AccessKeyView {
  nonce: bigint | number | string;
  permission: unknown;
}

/** Checks against the chain: the key is the clause's function-call key for submit_delivery, and the delegate is fresh. */
export async function checkDeliveryOnChain(d: DecodedDelivery, provider: Pick<JsonRpcProvider, "viewAccessKey" | "viewBlock">): Promise<void> {
  const da = d.signedDelegate.delegateAction;
  let key: AccessKeyView;
  try {
    key = (await provider.viewAccessKey({ accountId: da.senderId, publicKey: d.publicKey.toString() })) as unknown as AccessKeyView;
  } catch {
    throw new RelayRefusedError(`${d.publicKey.toString()} is not a key on ${da.senderId}`);
  }
  const perm = key.permission as { FunctionCall?: { receiver_id: string; method_names: string[] } } | string;
  const fcPerm = typeof perm === "object" ? perm.FunctionCall : undefined;
  if (!fcPerm || fcPerm.receiver_id !== da.senderId || fcPerm.method_names.length !== 1 || fcPerm.method_names[0] !== DELIVERY_METHOD) {
    throw new RelayRefusedError("the signing key is not the clause's submit_delivery function-call key");
  }
  if (d.nonce <= BigInt(key.nonce)) throw new RelayRefusedError("delegate nonce already used");
  const head = await provider.viewBlock({ finality: "final" });
  if (BigInt(head.header.height) > d.maxBlockHeight) throw new RelayRefusedError("delegate has expired (past maxBlockHeight)");
}

export interface RelayResult {
  txHash: string;
  senderId: string;
}

/** Validates, then submits from the relayer account, which pays the gas. */
export async function relayDelivery(
  relayer: Pick<Account, "relayMetaTransaction">,
  base64: string,
  opts: StaticCheckOptions & { provider: Pick<JsonRpcProvider, "viewAccessKey" | "viewBlock"> }
): Promise<RelayResult> {
  const d = decodeSignedDelegate(base64);
  checkDeliveryStatic(d, opts);
  await checkDeliveryOnChain(d, opts.provider);
  const res = await relayer.relayMetaTransaction(d.signedDelegate);
  const txHash = (res as { transaction?: { hash?: string } }).transaction?.hash ?? "";
  const failure = (res as { status?: { Failure?: unknown } }).status?.Failure ?? innerFailure(res, d.senderId);
  if (failure) throw new DeliveryRefusedError(`The clause refused the delivery: ${panicReason(failure)}`, txHash);
  return { txHash, senderId: d.senderId };
}

/** The relayed transaction succeeded, but the clause itself refused the call (for example after the deadline). */
export class DeliveryRefusedError extends Error {
  constructor(
    message: string,
    readonly txHash: string
  ) {
    super(message);
  }
}

/**
 * A meta-transaction's outer status reports the delegate action, not the
 * call inside it. The call runs as its own receipt on the clause account, so
 * a panic there (DEADLINE_PASSED, NOT_FUNDED...) only shows in that receipt.
 */
export function innerFailure(res: unknown, clauseAccountId: string): unknown {
  const receipts = (res as { receipts_outcome?: Array<{ outcome?: { executor_id?: string; status?: { Failure?: unknown } } }> }).receipts_outcome ?? [];
  return receipts.find((r) => r.outcome?.executor_id === clauseAccountId && r.outcome.status?.Failure)?.outcome?.status?.Failure;
}

function panicReason(failure: unknown): string {
  const s = JSON.stringify(failure);
  return s.match(/Smart contract panicked: ([A-Z_:]+[^"\\]*)/)?.[1] ?? s.slice(0, 200);
}
