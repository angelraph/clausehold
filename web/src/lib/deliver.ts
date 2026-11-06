import { api } from "./api";
import { delegateSigningBytes, encodeDeliveryDelegate, encodeSignedDelegate, publicKeyBytes, toBase64 } from "./delegate";
import { importSeed, type WorkerKey } from "./workerKey";

function hex(b: ArrayBuffer): string {
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** sha256 of a delivered file, computed in the browser. The file itself never leaves the device. */
export async function hashFile(file: File): Promise<string> {
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))}`;
}

export async function hashText(text: string): Promise<string> {
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))}`;
}

/**
 * Signs submit_delivery with the worker key and hands it to the relayer,
 * which pays the gas. The key can do nothing else, so this is the whole
 * of what the payee ever signs.
 */
export async function submitDelivery(clauseAccountId: string, key: WorkerKey, hash: string): Promise<{ txHash: string; status: string }> {
  const prep = await api.prepareRelay(clauseAccountId, key.publicKey);
  const delegate = encodeDeliveryDelegate({
    clauseAccountId,
    publicKey: publicKeyBytes(key.publicKey),
    nonce: BigInt(prep.nonce),
    maxBlockHeight: BigInt(prep.maxBlockHeight),
    hash,
  });
  const digest = await crypto.subtle.digest("SHA-256", delegateSigningBytes(delegate));
  const { privateKey } = await importSeed(key.seed);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, digest));
  return api.relay(toBase64(encodeSignedDelegate(delegate, signature)));
}
