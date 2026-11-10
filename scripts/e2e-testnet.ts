/**
 * One clause, start to finish, against the hosted testnet desk.
 *
 *   npm run e2e:testnet
 *
 * It walks the same road a real job takes:
 *   1. the studio agent opens an invite for a 2 mUSD job
 *   2. the editor's key is made here (as the browser would) and bound, so the
 *      desk writes r-<n>.clausehold.testnet with that one key on it
 *   3. the buyer tops up from the mUSD faucet and pays the clause
 *   4. the editor signs submit_delivery and the desk relays it, paying the gas
 *   5. the clause releases and the payee's balance goes up by 2 mUSD
 *
 * Env:
 *   CLAUSEHOLD_E2E_API     desk URL (default the hosted testnet desk)
 *   CLAUSEHOLD_E2E_BUYER   buyer account, its key in ~/.near-credentials/testnet (default clausehold-ops.testnet)
 *   CLAUSEHOLD_E2E_PAYEE   payee account (default clausehold.testnet)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { delegateSigningBytes, encodeDeliveryDelegate, encodeSignedDelegate, publicKeyBytes, toBase64 } from "../web/src/lib/delegate.js";

const API = process.env.CLAUSEHOLD_E2E_API ?? "https://clausehold-api-testnet.vercel.app";
const BUYER = process.env.CLAUSEHOLD_E2E_BUYER ?? "clausehold-ops.testnet";
const PAYEE = process.env.CLAUSEHOLD_E2E_PAYEE ?? "clausehold.testnet";
const FT = "musd.clausehold.testnet";
const MANDATE = "b2f1e9a0-1a2b-4c3d-8e4f-000000000001";
const AMOUNT = 2;
const BASE = BigInt(AMOUNT) * 1_000_000n;

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });

function step(n: number, text: string) {
  console.log(`\n${n}. ${text}`);
}

async function desk<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} answered ${res.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

async function balance(account: string): Promise<bigint> {
  const r = await provider.callFunction<string>({ contractId: FT, method: "ft_balance_of", args: { account_id: account } });
  return BigInt((r as string) ?? "0");
}

function buyerAccount(): Account {
  const file = join(homedir(), ".near-credentials", "testnet", `${BUYER}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(BUYER, provider, private_key as KeyPairString);
}

/** The editor's key: a fresh ed25519 key, like the one the browser makes. */
function workerKey() {
  const pair = KeyPair.fromRandom("ed25519");
  return { pair, publicKey: pair.getPublicKey().toString() };
}

/** The clause the factory made for this worker key, read from its recent clauses. */
async function clauseForKey(factory: string, workerPk: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const count = (await provider.callFunction({ contractId: factory, method: "clause_count", args: {} })) as number;
    const recent = (await provider.callFunction({ contractId: factory, method: "get_clauses", args: { from_index: Math.max(0, count - 50), limit: 50 } })) as Array<{ account_id: string; worker_pk: string }>;
    const hit = recent.find((c) => c.worker_pk === workerPk);
    if (hit) return hit.account_id;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function main() {
  console.log(`Desk ${API}\nBuyer ${BUYER}, payee ${PAYEE}, ${AMOUNT} mUSD`);
  const buyer = buyerAccount();
  const payeeBefore = await balance(PAYEE);

  step(1, "The studio agent opens an invite");
  const opened = await desk<{ verdict: { decision: string }; invite: { inviteId: string } | null; proposal: { id: string } }>("/invites", {
    method: "POST",
    body: JSON.stringify({
      agentId: "e2e-testnet",
      mandateId: MANDATE,
      buyer: BUYER,
      payee: PAYEE,
      asset: "USDC",
      amount: AMOUNT,
      terms: "End to end check: a 30 second cut",
      deadlineMinutes: 15,
      challengeSecs: 0,
    }),
  });
  if (!opened.invite) throw new Error(`The mandate refused the clause (${opened.verdict.decision})`);
  console.log(`   verdict ${opened.verdict.decision}, invite ${opened.invite.inviteId}`);

  step(2, "The editor binds a key, and the clause is written bound to it");
  const key = workerKey();
  const bound = await desk<{ invite: { status: string; clauseAccountId: string | null }; pendingReason: string | null }>(`/invites/${opened.invite.inviteId}/key`, {
    method: "POST",
    body: JSON.stringify({ publicKey: key.publicKey, keySource: "browser-random" }),
  });
  let clause = bound.invite.clauseAccountId;
  if (bound.invite.status !== "written" || !clause) {
    // A desk in wallet mode leaves the writing to the buyer, as the website does: it hands over
    // the exact create_clause call, the buyer signs and pays for it, and the desk checks the result on chain.
    const call = await desk<{ receiverId: string; methodName: string; args: Record<string, unknown>; deposit: string; gas: string }>(`/invites/${opened.invite.inviteId}/create`);
    const sent = await buyer.callFunctionRaw({ contractId: call.receiverId, methodName: call.methodName, args: call.args, deposit: BigInt(call.deposit), gas: BigInt(call.gas) });
    clause = await clauseForKey(call.receiverId, key.publicKey);
    if (!clause) throw new Error("The factory did not create the clause; the deposit was refunded");
    await desk(`/invites/${opened.invite.inviteId}/written`, { method: "POST", body: JSON.stringify({ clauseAccountId: clause, txHash: sent.transaction.hash }) });
    console.log(`   written by the buyer's own key, tx ${sent.transaction.hash}`);
  }
  console.log(`   ${clause}`);
  const keys = await provider.viewAccessKeyList({ accountId: clause });
  console.log(`   keys on the clause: ${keys.keys.map((k) => `${k.public_key} (${typeof k.access_key.permission === "string" ? k.access_key.permission : "FunctionCall"})`).join(", ")}`);

  step(3, "The buyer pays the clause");
  if ((await balance(BUYER)) < BASE) {
    await buyer.callFunction({ contractId: FT, methodName: "faucet", args: {}, gas: 30_000_000_000_000n });
  }
  await buyer.callFunction({
    contractId: FT,
    methodName: "ft_transfer_call",
    args: { receiver_id: clause, amount: BASE.toString(), msg: "" },
    gas: 150_000_000_000_000n,
    deposit: 1n,
  });
  // sync_funding is open to anyone; the desk route is a convenience. Older desks lack it, so call the clause directly then.
  const funded = await desk<{ status: string }>(`/clauses/${opened.proposal.id}/check-funding`, { method: "POST" }).catch(async () => {
    await buyer.callFunction({ contractId: clause, methodName: "sync_funding", args: {}, gas: 100_000_000_000_000n });
    return { status: "synced on chain" };
  });
  const stateNow = (await provider.callFunction({ contractId: clause, method: "get_state", args: {} })) as { status?: string };
  console.log(`   clause holds ${Number(await balance(clause)) / 1e6} mUSD, status ${stateNow.status ?? funded.status}`);

  step(4, "The editor delivers; the desk pays the gas");
  const prep = await desk<{ nonce: string; maxBlockHeight: string }>(`/relay/prepare?clause=${clause}&publicKey=${encodeURIComponent(key.publicKey)}`).catch(async () => {
    const [ak, block] = await Promise.all([
      provider.viewAccessKey({ accountId: clause, publicKey: key.publicKey }),
      provider.viewBlock({ finality: "final" }),
    ]);
    return { nonce: (BigInt(ak.nonce) + 1n).toString(), maxBlockHeight: (BigInt(block.header.height) + 600n).toString() };
  });
  const hash = `sha256:${createHash("sha256").update("cut-30s.mp4 from the e2e run").digest("hex")}`;
  const delegate = encodeDeliveryDelegate({
    clauseAccountId: clause,
    publicKey: publicKeyBytes(key.publicKey),
    nonce: BigInt(prep.nonce),
    maxBlockHeight: BigInt(prep.maxBlockHeight),
    hash,
  });
  const digest = createHash("sha256").update(delegateSigningBytes(delegate)).digest();
  const { signature } = key.pair.sign(new Uint8Array(digest));
  const relayed = await desk<{ txHash: string; status: string }>("/relay", {
    method: "POST",
    body: JSON.stringify({ signedDelegate: toBase64(encodeSignedDelegate(delegate, signature)) }),
  });
  console.log(`   tx ${relayed.txHash}, status ${relayed.status}`);

  step(5, "Check the money moved");
  const state = await provider.callFunction({ contractId: clause, method: "get_state", args: {} });
  const payeeAfter = await balance(PAYEE);
  console.log(`   clause state ${JSON.stringify((state as { status?: string }).status ?? state)}`);
  console.log(`   payee ${Number(payeeBefore) / 1e6} -> ${Number(payeeAfter) / 1e6} mUSD`);
  console.log(`   explorer https://testnet.nearblocks.io/address/${clause}`);
  if (payeeAfter - payeeBefore !== BASE) throw new Error("The payee did not receive the clause amount");

  step(6, "Close the clause and get its storage NEAR back");
  const view = (await provider.callFunction({ contractId: clause, method: "get_clause", args: {} })) as { reported?: boolean };
  if (view.reported === undefined) {
    console.log("   this clause was written with code that has no close; skipping");
  } else {
    if (!view.reported) throw new Error("The factory has not recorded the outcome yet");
    const held = BigInt((await provider.viewAccount({ accountId: clause })).amount);
    const buyerBefore = BigInt((await provider.viewAccount({ accountId: BUYER })).amount);
    const closed = await buyer.callFunctionRaw({ contractId: clause, methodName: "close", args: {}, gas: 100_000_000_000_000n });
    const gone = await provider.viewAccount({ accountId: clause }).then(() => false).catch(() => true);
    const buyerAfter = BigInt((await provider.viewAccount({ accountId: BUYER })).amount);
    console.log(`   tx ${closed.transaction.hash}`);
    console.log(`   clause held ${Number(held / 10n ** 20n) / 1e4} NEAR; buyer +${Number((buyerAfter - buyerBefore) / 10n ** 20n) / 1e4} NEAR after the fee`);
    if (!gone) throw new Error("The clause account still exists after close");
  }
  console.log("\nPassed: written, funded, delivered without gas, released, closed.");
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
