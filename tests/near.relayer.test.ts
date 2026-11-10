import { describe, it, expect } from "vitest";
import { actions, buildDelegateAction, encodeSignedDelegate, KeyPair, KeyPairSigner, PublicKey } from "near-api-js";
import { checkDeliveryOnChain, checkDeliveryStatic, decodeSignedDelegate, DeliveryRefusedError, isClauseAccount, RelayRefusedError, relayDelivery } from "../src/near/relayer.js";

const FACTORY = "clausehold.testnet";
const CLAUSE = `r-104.${FACTORY}`;

const workerKey = KeyPair.fromRandom("ed25519");
const otherKey = KeyPair.fromRandom("ed25519");

interface BuildOpts {
  senderId?: string;
  receiverId?: string;
  method?: string;
  args?: Record<string, unknown>;
  deposit?: bigint;
  gas?: bigint;
  extraAction?: boolean;
  nonce?: bigint;
  maxBlockHeight?: bigint;
  signWith?: KeyPair;
  claimedKey?: KeyPair;
}

async function build(o: BuildOpts = {}): Promise<string> {
  const fc = actions.functionCall(o.method ?? "submit_delivery", o.args ?? { hash: "sha256:abc" }, o.gas ?? 50_000_000_000_000n, o.deposit ?? 0n);
  const da = buildDelegateAction({
    senderId: o.senderId ?? CLAUSE,
    receiverId: o.receiverId ?? CLAUSE,
    actions: o.extraAction ? [fc, actions.transfer(1n)] : [fc],
    nonce: o.nonce ?? 5n,
    maxBlockHeight: o.maxBlockHeight ?? 1000n,
    publicKey: (o.claimedKey ?? workerKey).getPublicKey(),
  });
  const signer = new KeyPairSigner(o.signWith ?? workerKey);
  let signed;
  if (o.signWith && o.signWith !== (o.claimedKey ?? workerKey)) {
    // Sign with a different key than the one the delegate claims: forge a bad signature.
    const { signedDelegate } = await new KeyPairSigner(o.claimedKey ?? workerKey).signDelegateAction(da);
    const forged = o.signWith.sign(new Uint8Array(32)).signature;
    signedDelegate.signature.ed25519Signature!.data = forged;
    signed = signedDelegate;
  } else {
    signed = (await signer.signDelegateAction(da)).signedDelegate;
  }
  return Buffer.from(encodeSignedDelegate(signed)).toString("base64");
}

function chain(over: { permission?: unknown; nonce?: bigint; height?: bigint; missing?: boolean } = {}) {
  return {
    viewAccessKey: async () => {
      if (over.missing) throw new Error("does not exist");
      return { nonce: over.nonce ?? 4n, permission: over.permission ?? { FunctionCall: { receiver_id: CLAUSE, method_names: ["submit_delivery"], allowance: null } } } as never;
    },
    viewBlock: async () => ({ header: { height: Number(over.height ?? 900n) } }) as never,
  };
}

describe("decodeSignedDelegate", () => {
  it("round-trips: decoding and re-encoding gives the same bytes the browser sent", async () => {
    const b64 = await build();
    const d = decodeSignedDelegate(b64);
    expect(Buffer.from(encodeSignedDelegate(d.signedDelegate)).toString("base64")).toBe(b64);
    expect(d.senderId).toBe(CLAUSE);
    expect(d.args).toEqual({ hash: "sha256:abc" });
    expect(d.publicKey.toString()).toBe(workerKey.getPublicKey().toString());
  });

  it("refuses garbage", async () => {
    expect(() => decodeSignedDelegate("bm90IGEgZGVsZWdhdGU=")).toThrow(RelayRefusedError);
  });

  it("refuses a method other than submit_delivery", async () => {
    const b64 = await build({ method: "release" });
    expect(() => decodeSignedDelegate(b64)).toThrow(/submit_delivery/);
  });

  it("refuses a deposit, and more than one action", async () => {
    const withDeposit = await build({ deposit: 1n });
    const twoActions = await build({ extraAction: true });
    expect(() => decodeSignedDelegate(withDeposit)).toThrow(/deposit/);
    expect(() => decodeSignedDelegate(twoActions)).toThrow(/exactly one action/);
  });
});

describe("checkDeliveryStatic", () => {
  const opts = { factoryAccountId: FACTORY };

  it("accepts a well-formed delivery signed by the claimed key", async () => {
    const d = decodeSignedDelegate(await build());
    expect(() => checkDeliveryStatic(d, opts)).not.toThrow();
  });

  it("refuses a sender that is not a clause account under our factory", async () => {
    for (const senderId of ["alice.testnet", "r-1.evil.testnet", `x-1.${FACTORY}`, `r-1.sub.${FACTORY}`]) {
      const d = decodeSignedDelegate(await build({ senderId, receiverId: senderId }));
      expect(() => checkDeliveryStatic(d, opts)).toThrow(/not a clause account/);
    }
  });

  it("refuses a call to any account other than the clause itself", async () => {
    const d = decodeSignedDelegate(await build({ receiverId: "usdc.testnet" }));
    expect(() => checkDeliveryStatic(d, opts)).toThrow(/clause account itself/);
  });

  it("refuses a bad signature before any gas is spent", async () => {
    const d = decodeSignedDelegate(await build({ signWith: otherKey }));
    expect(() => checkDeliveryStatic(d, opts)).toThrow(/signature/);
  });

  it("refuses an empty delivery hash and excessive gas", async () => {
    const emptyHash = decodeSignedDelegate(await build({ args: { hash: "" } }));
    const tooMuchGas = decodeSignedDelegate(await build({ gas: 400_000_000_000_000n }));
    expect(() => checkDeliveryStatic(emptyHash, opts)).toThrow(/hash/);
    expect(() => checkDeliveryStatic(tooMuchGas, opts)).toThrow(/gas/);
  });
});

describe("checkDeliveryOnChain", () => {
  it("accepts the clause's submit_delivery key with a fresh nonce", async () => {
    await expect(checkDeliveryOnChain(decodeSignedDelegate(await build()), chain())).resolves.toBeUndefined();
  });

  it("refuses a key that is not on the account", async () => {
    await expect(checkDeliveryOnChain(decodeSignedDelegate(await build()), chain({ missing: true }))).rejects.toThrow(/not a key/);
  });

  it("refuses a full-access key or a key for another method", async () => {
    const d = decodeSignedDelegate(await build());
    await expect(checkDeliveryOnChain(d, chain({ permission: "FullAccess" }))).rejects.toThrow(/function-call key/);
    await expect(checkDeliveryOnChain(d, chain({ permission: { FunctionCall: { receiver_id: CLAUSE, method_names: ["release"] } } }))).rejects.toThrow(/function-call key/);
  });

  it("refuses a replayed nonce and an expired delegate", async () => {
    const d = decodeSignedDelegate(await build({ nonce: 5n, maxBlockHeight: 1000n }));
    await expect(checkDeliveryOnChain(d, chain({ nonce: 5n }))).rejects.toThrow(/nonce/);
    await expect(checkDeliveryOnChain(d, chain({ height: 1001n }))).rejects.toThrow(/expired/);
  });
});

describe("relayDelivery", () => {
  it("submits a valid delivery from the relayer and returns the tx hash", async () => {
    let relayed: unknown;
    const relayer = { relayMetaTransaction: async (sd: unknown) => ((relayed = sd), { transaction: { hash: "TX1" }, status: { SuccessValue: "" } }) as never };
    const res = await relayDelivery(relayer, await build(), { factoryAccountId: FACTORY, provider: chain() });
    expect(res).toEqual({ txHash: "TX1", senderId: CLAUSE });
    expect(relayed).toBeDefined();
  });

  it("never calls the relayer for a refused delivery", async () => {
    let called = false;
    const relayer = { relayMetaTransaction: async () => ((called = true), {}) as never };
    await expect(relayDelivery(relayer, await build({ signWith: otherKey }), { factoryAccountId: FACTORY, provider: chain() })).rejects.toThrow(RelayRefusedError);
    expect(called).toBe(false);
  });

  it("reports an on-chain failure instead of claiming success", async () => {
    const relayer = { relayMetaTransaction: async () => ({ transaction: { hash: "TX2" }, status: { Failure: { ActionError: "x" } } }) as never };
    await expect(relayDelivery(relayer, await build(), { factoryAccountId: FACTORY, provider: chain() })).rejects.toThrow(/clause refused the delivery/);
  });

  it("reports a panic inside the relayed call, even when the outer status is a success", async () => {
    const delegate = await build();
    const sender = decodeSignedDelegate(delegate).senderId;
    const relayer = {
      relayMetaTransaction: async () =>
        ({
          transaction: { hash: "TX3" },
          status: { SuccessValue: "" },
          receipts_outcome: [{ outcome: { executor_id: sender, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: DEADLINE_PASSED" } } } } } } }],
        }) as never,
    };
    const err = await relayDelivery(relayer, delegate, { factoryAccountId: FACTORY, provider: chain() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryRefusedError);
    expect((err as DeliveryRefusedError).message).toContain("DEADLINE_PASSED");
    expect((err as DeliveryRefusedError).txHash).toBe("TX3");
  });
});

describe("isClauseAccount", () => {
  it("matches only r-<digits>.<factory>", async () => {
    expect(isClauseAccount(`r-0.${FACTORY}`, FACTORY)).toBe(true);
    expect(isClauseAccount(`r-12345.${FACTORY}`, FACTORY)).toBe(true);
    expect(isClauseAccount(FACTORY, FACTORY)).toBe(false);
    expect(isClauseAccount(`r-.${FACTORY}`, FACTORY)).toBe(false);
    expect(isClauseAccount(`r-1${FACTORY}`, FACTORY)).toBe(false);
  });
});

// Keeps the PublicKey import used for type parity checks in editors.
void PublicKey;
