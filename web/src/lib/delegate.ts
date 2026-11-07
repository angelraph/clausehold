/**
 * Builds the NEP-366 delegate action a payee signs to submit delivery, in
 * NEAR's borsh wire format, with no dependencies, so it runs in any
 * browser. The relayer decodes these exact bytes, checks them, and pays
 * the gas. Nothing here touches keys: signing is done by the caller.
 */

/** NEP-461 prefix for delegate actions: 2^30 + 366, as a little-endian u32. */
export const DELEGATE_PREFIX = 2 ** 30 + 366;
/** submit_delivery may release in the same call, which needs at least 150 Tgas. */
export const DELIVERY_GAS = 200_000_000_000_000n;

class Writer {
  private chunks: number[] = [];
  u8(n: number) {
    this.chunks.push(n & 0xff);
  }
  u32(n: number) {
    for (let i = 0; i < 4; i++) this.u8(Math.floor(n / 2 ** (8 * i)));
  }
  u64(n: bigint) {
    for (let i = 0n; i < 8n; i++) this.u8(Number((n >> (8n * i)) & 0xffn));
  }
  u128(n: bigint) {
    for (let i = 0n; i < 16n; i++) this.u8(Number((n >> (8n * i)) & 0xffn));
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.u8(x);
  }
  vecBytes(b: Uint8Array) {
    this.u32(b.length);
    this.bytes(b);
  }
  str(s: string) {
    this.vecBytes(new TextEncoder().encode(s));
  }
  out(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export interface DeliveryDelegate {
  /** The clause account, r-<n>.<factory>. It is both sender and receiver. */
  clauseAccountId: string;
  /** The worker key's raw 32-byte ed25519 public key. */
  publicKey: Uint8Array;
  nonce: bigint;
  maxBlockHeight: bigint;
  hash: string;
  noteHash?: string;
}

/** Borsh bytes of the DelegateAction (without the NEP-461 prefix). */
export function encodeDeliveryDelegate(d: DeliveryDelegate): Uint8Array {
  if (d.publicKey.length !== 32) throw new Error("worker public key must be 32 bytes");
  const args = new TextEncoder().encode(JSON.stringify(d.noteHash ? { hash: d.hash, note_hash: d.noteHash } : { hash: d.hash }));
  const w = new Writer();
  w.str(d.clauseAccountId); // sender_id
  w.str(d.clauseAccountId); // receiver_id
  w.u32(1); // one action
  w.u8(2); // Action::FunctionCall
  w.str("submit_delivery");
  w.vecBytes(args);
  w.u64(DELIVERY_GAS);
  w.u128(0n); // deposit
  w.u64(d.nonce);
  w.u64(d.maxBlockHeight);
  w.u8(0); // PublicKey::ED25519
  w.bytes(d.publicKey);
  return w.out();
}

/** The exact bytes whose sha256 the worker key signs: prefix then delegate action. */
export function delegateSigningBytes(delegate: Uint8Array): Uint8Array {
  const w = new Writer();
  w.u32(DELEGATE_PREFIX);
  w.bytes(delegate);
  return w.out();
}

/** Borsh bytes of the SignedDelegate the relayer accepts. */
export function encodeSignedDelegate(delegate: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("ed25519 signature must be 64 bytes");
  const w = new Writer();
  w.bytes(delegate);
  w.u8(0); // Signature::ED25519
  w.bytes(signature);
  return w.out();
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** "ed25519:<base58>" -> the raw 32 key bytes. */
export function publicKeyBytes(publicKey: string): Uint8Array {
  const b58 = publicKey.replace(/^ed25519:/, "");
  let n = 0n;
  for (const c of b58) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not a base58 key");
    n = n * 58n + BigInt(i);
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}
