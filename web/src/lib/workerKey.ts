/**
 * The editor's worker key: an ed25519 key that will be the only key on the
 * clause account, allowed to call submit_delivery and nothing else.
 *
 * Preferred source: a passkey with the WebAuthn PRF extension. The passkey
 * derives the same 32-byte seed every time, so nothing secret is stored.
 * Fallback, when the browser or authenticator has no PRF: 32 random bytes
 * from crypto.getRandomValues, kept in this browser only. Either way a lost
 * key cannot move money; the clause just expires and returns to the buyer.
 */

export type KeySource = "passkey-prf" | "browser-random";

export interface WorkerKey {
  publicKey: string; // "ed25519:<base58>"
  source: KeySource;
  seed: Uint8Array;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

/** PKCS#8 wrapper for a raw 32-byte Ed25519 seed. */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export async function importSeed(seed: Uint8Array): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return { privateKey, publicKey: `ed25519:${base58(b64urlToBytes(jwk.x!))}` };
}

export async function ed25519Supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]);
    return true;
  } catch {
    return false;
  }
}

const SALT = new TextEncoder().encode("clausehold worker key v1");

/** Creates a passkey and derives the worker seed from its PRF output. Returns null if PRF is unavailable. */
async function passkeySeed(inviteId: string, label: string): Promise<Uint8Array | null> {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) return null;
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Clausehold" },
      user: { id: new TextEncoder().encode(inviteId).slice(0, 64), name: label, displayName: label },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  let out = ext.prf?.results?.first;
  if (!out && ext.prf?.enabled) {
    // Some authenticators only return PRF output on a get(), not on create().
    const got = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: cred.rawId }],
        userVerification: "required",
        extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    out = (got?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
  }
  if (!out) return null;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", out));
}

const storeKey = (inviteId: string) => `clausehold.worker.${inviteId}`;

export async function createWorkerKey(inviteId: string, label: string): Promise<WorkerKey> {
  let seed: Uint8Array | null = null;
  let source: KeySource = "passkey-prf";
  try {
    seed = await passkeySeed(inviteId, label);
  } catch {
    seed = null;
  }
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32));
    source = "browser-random";
  }
  const { publicKey } = await importSeed(seed);
  try {
    localStorage.setItem(storeKey(inviteId), JSON.stringify({ seed: Array.from(seed), source, publicKey }));
  } catch {
    /* private mode: the key lives for this page only */
  }
  return { publicKey, source, seed };
}

export function loadWorkerKey(inviteId: string): WorkerKey | null {
  try {
    const raw = localStorage.getItem(storeKey(inviteId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { seed: number[]; source: KeySource; publicKey: string };
    return { seed: Uint8Array.from(v.seed), source: v.source, publicKey: v.publicKey };
  } catch {
    return null;
  }
}
