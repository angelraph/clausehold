/**
 * Get back the NEAR a factory account has locked for storage.
 *
 * NEAR locks about 1 NEAR per 100 KB an account stores. A Clausehold factory
 * stores its own code and the clause code (about 420 KB, about 4.2 NEAR).
 * That NEAR stays in the owner's account the whole time; this script frees it:
 *   1. deploy contracts/cleanup over the factory (12 KB, no state, cannot move funds)
 *   2. read every storage key with the RPC view_state call
 *   3. call clean() from the account's own key, which removes them
 *   4. optionally delete the account and send everything to another account
 *
 * Rehearsal on testnet (creates a throwaway factory, recovers it, deletes it):
 *   npx tsx scripts/recover-storage.ts --rehearse
 *
 * For real (only when you want to retire a factory):
 *   npx tsx scripts/recover-storage.ts --network mainnet --account clausehold.near
 *   ...add --delete-to <account> to also delete the account afterwards.
 *
 * Keys come from ~/.near-credentials/<network>/<account>.json.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from "near-api-js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const rehearse = argv.includes("--rehearse");
const network = (flag("network") ?? "testnet") as "testnet" | "mainnet";
const rpc = network === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: rpc });
const TGAS = 10n ** 12n;
const NEAR = 10n ** 24n;
const BYTE = 10n ** 19n;

const wasm = (name: string) => new Uint8Array(readFileSync(`contracts/target/near/${name}/${name}.wasm`));
const near = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);

function keychain(accountId: string): Account {
  const file = join(homedir(), ".near-credentials", network, `${accountId}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(accountId, provider, private_key as KeyPairString);
}

async function report(accountId: string, label: string) {
  const a = await provider.viewAccount({ accountId });
  const total = BigInt(a.amount);
  const locked = BigInt(a.storage_usage) * BYTE;
  console.log(`   ${label}: ${a.storage_usage} bytes stored, ${near(locked)} NEAR locked for it, ${near(total - locked)} NEAR free to spend`);
  return { total, locked, bytes: a.storage_usage };
}

/** Every key the contract stores, from the RPC. */
async function storageKeys(accountId: string): Promise<Uint8Array[]> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_state", finality: "final", account_id: accountId, prefix_base64: "" } }),
  });
  const body = (await res.json()) as { result?: { values: Array<{ key: string }> }; error?: unknown };
  if (!body.result) throw new Error(`view_state failed: ${JSON.stringify(body.error)}`);
  return body.result.values.map((v) => new Uint8Array(Buffer.from(v.key, "base64")));
}

/** `[u16 LE length][key]...`, the input format contracts/cleanup reads. */
function encodeKeys(keys: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const k of keys) {
    if (k.length > 0xffff) throw new Error("key too long");
    parts.push(k.length & 0xff, k.length >> 8, ...k);
  }
  return new Uint8Array(parts);
}

async function recover(owner: Account) {
  const keys = await storageKeys(owner.accountId);
  console.log(`   ${keys.length} storage keys found`);
  const r1 = await owner.signAndSendTransaction({ receiverId: owner.accountId, actions: [actions.deployContract(wasm("cleanup"))] });
  console.log(`   cleanup contract deployed over the factory, tx ${r1.transaction.hash}`);
  const r2 = await owner.signAndSendTransaction({ receiverId: owner.accountId, actions: [actions.functionCall("clean", encodeKeys(keys), 100n * TGAS, 0n)] });
  console.log(`   clean() removed them, tx ${r2.transaction.hash}`);
}

async function main() {
  if (rehearse) {
    if (network !== "testnet") throw new Error("--rehearse runs on testnet only");
    const funder = keychain(flag("funder") ?? "clausehold-ops.testnet");
    const id = `retire-${Date.now().toString(36)}.${funder.accountId}`;
    const pair = KeyPair.fromRandom("ed25519");
    console.log(`Rehearsal on testnet with a throwaway factory ${id}\n`);
    console.log("1. Set up a factory exactly like the real one");
    await funder.createAccount({ newAccountId: id, publicKey: pair.getPublicKey(), nearToTransfer: 6n * NEAR });
    const owner = new Account(id, provider, pair.toString() as KeyPairString);
    await owner.signAndSendTransaction({
      receiverId: id,
      actions: [actions.deployContract(wasm("factory")), actions.functionCall("new", { owner: id, mandate: null }, 30n * TGAS, 0n)],
    });
    await owner.signAndSendTransaction({ receiverId: id, actions: [actions.functionCall("set_clause_code", wasm("clause"), 300n * TGAS, 0n)] });
    const before = await report(id, "with the factory and clause code");

    console.log("\n2. Recover the storage");
    await recover(owner);
    const after = await report(id, "after cleanup");
    console.log(`   freed ${near(before.locked - after.locked)} NEAR`);

    console.log("\n3. Delete the throwaway account, everything goes back to the funder");
    const funderBefore = BigInt((await provider.viewAccount({ accountId: funder.accountId })).amount);
    const del = await owner.deleteAccount(funder.accountId);
    const funderAfter = BigInt((await provider.viewAccount({ accountId: funder.accountId })).amount);
    console.log(`   deleted, tx ${del.transaction.hash}; ${funder.accountId} got ${near(funderAfter - funderBefore)} NEAR back`);
    console.log("\nRehearsal passed: the locked storage NEAR came back.");
    return;
  }

  const accountId = flag("account");
  if (!accountId) throw new Error("Pass --account <factory account>, or --rehearse");
  const owner = keychain(accountId);
  console.log(`Recovering storage on ${network} for ${accountId}\n`);
  const before = await report(accountId, "now");
  await recover(owner);
  const after = await report(accountId, "after cleanup");
  console.log(`   freed ${near(before.locked - after.locked)} NEAR`);
  const to = flag("delete-to");
  if (to) {
    const del = await owner.deleteAccount(to);
    console.log(`   deleted ${accountId}, everything sent to ${to}, tx ${del.transaction.hash}`);
  }
}

main().catch((err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
