import { describe, it, expect } from "vitest";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { KeyPair } from "near-api-js";
import { delegateSigningBytes, encodeDeliveryDelegate, encodeSignedDelegate, publicKeyBytes, toBase64 } from "../web/src/lib/delegate.js";
import { checkDeliveryStatic, decodeSignedDelegate } from "../src/near/relayer.js";

const CLAUSE = "r-104.clausehold.testnet";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Signs like the browser does: ed25519 over sha256(prefix + delegate bytes), from a raw 32-byte seed. */
function browserSign(seed: Uint8Array, delegate: Uint8Array): Uint8Array {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const digest = createHash("sha256").update(delegateSigningBytes(delegate)).digest();
  return new Uint8Array(sign(null, digest, key));
}

function keyFromSeed(seed: Uint8Array) {
  // near-api-js takes the 64-byte secret (seed + public key) in base58.
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const jwk = key.export({ format: "jwk" }) as { x: string };
  const pub = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  return pub;
}

describe("browser delivery delegate", () => {
  const seed = new Uint8Array(32).map((_, i) => i + 1);
  const pub = keyFromSeed(seed);

  function build(over: Partial<Parameters<typeof encodeDeliveryDelegate>[0]> = {}) {
    const delegate = encodeDeliveryDelegate({ clauseAccountId: CLAUSE, publicKey: pub, nonce: 7n, maxBlockHeight: 123456n, hash: "sha256:abc", ...over });
    return toBase64(encodeSignedDelegate(delegate, browserSign(seed, delegate)));
  }

  it("decodes on the relayer exactly as signed, and passes every static check", () => {
    const d = decodeSignedDelegate(build());
    expect(d.senderId).toBe(CLAUSE);
    expect(d.args).toEqual({ hash: "sha256:abc" });
    expect(d.nonce).toBe(7n);
    expect(d.maxBlockHeight).toBe(123456n);
    expect(d.gas).toBe(200_000_000_000_000n);
    expect(() => checkDeliveryStatic(d, { factoryAccountId: "clausehold.testnet" })).not.toThrow();
  });

  it("carries an optional note hash", () => {
    expect(decodeSignedDelegate(build({ noteHash: "f00d" })).args).toEqual({ hash: "sha256:abc", note_hash: "f00d" });
  });

  it("a signature over different bytes is refused", () => {
    const delegate = encodeDeliveryDelegate({ clauseAccountId: CLAUSE, publicKey: pub, nonce: 7n, maxBlockHeight: 1n, hash: "a" });
    const other = encodeDeliveryDelegate({ clauseAccountId: CLAUSE, publicKey: pub, nonce: 8n, maxBlockHeight: 1n, hash: "a" });
    const forged = toBase64(encodeSignedDelegate(delegate, browserSign(seed, other)));
    expect(() => checkDeliveryStatic(decodeSignedDelegate(forged), { factoryAccountId: "clausehold.testnet" })).toThrow(/signature/);
  });

  it("round-trips ed25519 public keys through base58", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const s = kp.getPublicKey().toString();
    expect(Buffer.from(publicKeyBytes(s))).toEqual(Buffer.from(kp.getPublicKey().data));
  });
});
