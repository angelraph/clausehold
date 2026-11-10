/**
 * Clausehold on NEAR mainnet: deploy the factory, run one real clause, close it.
 *
 *   npx tsx scripts/mainnet-proof.ts --payee <your-second-account.near> [--dry]
 *
 * Everything is signed by clausehold.near (key in ~/.near-credentials/mainnet).
 * Each step checks the chain first and skips what is already done, so a run
 * that stops halfway can simply be started again.
 *
 *   1. deploy the factory code and initialise it (owner: clausehold.near)
 *   2. upload the clause code
 *   3. set the mandate: native USDC only, small caps, and only clausehold.near may write clauses
 *   4. write one clause for 2 USDC to the payee, bound to a fresh worker key
 *   5. fund it with ft_transfer_call
 *   6. the worker key signs submit_delivery as a meta-transaction and clausehold.near
 *      relays it, so the worker pays no gas; the clause pays the payee in the same call
 *   7. close the clause: its account is deleted and its storage NEAR returns
 *   8. ask NEAR Intents 1Click for a dry quote to fund a clause from another chain
 *
 * Money: about 4.2 NEAR stays locked in clausehold.near for storage (recoverable with
 * scripts/recover-storage.ts), about 2 NEAR goes into the clause and comes back on close,
 * fees are a few hundredths of a NEAR, and 2 USDC moves to the payee.
 * --dry prints the plan and the costs without sending anything.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, actions, type KeyPairString } from "near-api-js";
import { delegateSigningBytes, encodeDeliveryDelegate, encodeSignedDelegate, publicKeyBytes, toBase64 } from "../web/src/lib/delegate.js";
import { decodeSignedDelegate } from "../src/near/relayer.js";

const FACTORY = "clausehold.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RPC = "https://rpc.mainnet.fastnear.com";
const TGAS = 10n ** 12n;
const BYTE = 10n ** 19n;
const tx = (h: string) => `https://nearblocks.io/txns/${h}`;

const argv = process.argv.slice(2);
const payee = argv[argv.indexOf("--payee") + 1] ?? "";
const dry = argv.includes("--dry");
if (!argv.includes("--payee") || !payee || !/\.near$|^[0-9a-f]{64}$/.test(payee)) {
  console.error("Pass --payee <existing mainnet account>, e.g. --payee yourname.near");
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: RPC });
const near = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);
const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId, method, args }) as Promise<T>;
const wasm = (name: string) => new Uint8Array(readFileSync(`contracts/target/near/${name}/${name}.wasm`));

function owner(): Account {
  const file = join(homedir(), ".near-credentials", "mainnet", `${FACTORY}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(FACTORY, provider, private_key as KeyPairString);
}

async function main() {
  const acct = await provider.viewAccount({ accountId: FACTORY });
  const balance = BigInt(acct.amount);
  const factoryCode = wasm("factory");
  const clauseCode = wasm("clause");
  const storage = BigInt(factoryCode.length + clauseCode.length + 4000) * BYTE;
  const usdc = BigInt((await view<string>(USDC, "ft_balance_of", { account_id: FACTORY })) ?? "0");
  await provider.viewAccount({ accountId: payee }).catch(() => {
    throw new Error(`${payee} does not exist on mainnet`);
  });
  console.log(`Mainnet proof for ${FACTORY}, payee ${payee}`);
  console.log(`  balance ${near(balance)} NEAR and ${Number(usdc) / 1e6} USDC`);
  console.log(`  storage to lock (yours, recoverable): about ${near(storage)} NEAR`);
  console.log(`  clause deposit (comes back on close): about 2.0 NEAR`);
  console.log(`  payment to ${payee}: 2 USDC`);
  if (balance < storage + 21n * 10n ** 23n) throw new Error("Not enough NEAR for the storage plus one clause deposit");
  if (usdc < 2_000_000n) throw new Error("clausehold.near needs at least 2 USDC");
  if (dry) {
    console.log("\n--dry: nothing sent.");
    return;
  }
  const me = owner();

  console.log("\n1-2. Factory and clause code");
  if (acct.code_hash === "11111111111111111111111111111111") {
    const r = await me.signAndSendTransaction({
      receiverId: FACTORY,
      actions: [actions.deployContract(factoryCode), actions.functionCall("new", { owner: FACTORY, mandate: null }, 30n * TGAS, 0n)],
    });
    console.log(`   factory deployed, ${tx(r.transaction.hash)}`);
  } else {
    console.log("   factory already deployed");
  }
  const info = await view<{ sha256: string } | null>(FACTORY, "clause_code_info");
  const sha = createHash("sha256").update(clauseCode).digest("hex");
  if (info?.sha256 !== sha) {
    const r = await me.signAndSendTransaction({ receiverId: FACTORY, actions: [actions.functionCall("set_clause_code", clauseCode, 300n * TGAS, 0n)] });
    console.log(`   clause code uploaded (sha256 ${sha.slice(0, 12)}…), ${tx(r.transaction.hash)}`);
  } else {
    console.log("   clause code already uploaded");
  }

  console.log("\n3. Mandate");
  const mandate = {
    allowed_assets: [USDC],
    max_per_clause: "5000000",
    per_payee_daily_cap: "10000000",
    daily_cap: "20000000",
    new_payee_ceiling: "3000000",
    paused: false,
    cosigner: FACTORY,
    creators: [FACTORY],
  };
  const current = await view<typeof mandate | null>(FACTORY, "get_mandate");
  if (JSON.stringify(current) !== JSON.stringify(mandate)) {
    const r = await me.callFunctionRaw({ contractId: FACTORY, methodName: "set_mandate", args: { mandate }, gas: 30n * TGAS });
    console.log(`   USDC only, 5 per clause, new payees 3, only ${FACTORY} may write clauses, ${tx(r.transaction.hash)}`);
  } else {
    console.log("   already set");
  }

  console.log("\n4. Write one clause");
  const worker = KeyPair.fromRandom("ed25519");
  const deposit = BigInt(await view<string>(FACTORY, "create_deposit"));
  const created = await me.callFunctionRaw({
    contractId: FACTORY,
    methodName: "create_clause",
    args: {
      buyer: FACTORY,
      payee,
      worker_pk: worker.getPublicKey().toString(),
      asset: USDC,
      amount: "2000000",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      terms_hash: createHash("sha256").update("Clausehold mainnet proof: one paid job, delivered and released").digest("hex"),
      challenge_secs: 0,
    },
    deposit,
    gas: 300n * TGAS,
  });
  const count = await view<number>(FACTORY, "clause_count");
  const clause = `r-${count - 1}.${FACTORY}`;
  console.log(`   ${clause}, deposit ${near(deposit)} NEAR, ${tx(created.transaction.hash)}`);

  console.log("\n5. Fund it with 2 USDC");
  const funded = await me.callFunctionRaw({ contractId: USDC, methodName: "ft_transfer_call", args: { receiver_id: clause, amount: "2000000", msg: "" }, gas: 100n * TGAS, deposit: 1n });
  console.log(`   state ${await view<string>(clause, "get_state")}, ${tx(funded.transaction.hash)}`);

  console.log("\n6. Deliver: the worker key signs, clausehold.near relays and pays the gas");
  const ak = await provider.viewAccessKey({ accountId: clause, publicKey: worker.getPublicKey().toString() });
  const block = await provider.viewBlock({ finality: "final" });
  const delegate = encodeDeliveryDelegate({
    clauseAccountId: clause,
    publicKey: publicKeyBytes(worker.getPublicKey().toString()),
    nonce: BigInt(ak.nonce) + 1n,
    maxBlockHeight: BigInt(block.header.height) + 600n,
    hash: `sha256:${createHash("sha256").update("mainnet delivery").digest("hex")}`,
  });
  const { signature } = worker.sign(new Uint8Array(createHash("sha256").update(delegateSigningBytes(delegate)).digest()));
  const payeeBefore = BigInt((await view<string>(USDC, "ft_balance_of", { account_id: payee })) ?? "0");
  const relayed = await me.relayMetaTransaction(decodeSignedDelegate(toBase64(encodeSignedDelegate(delegate, signature))).signedDelegate);
  const payeeAfter = BigInt((await view<string>(USDC, "ft_balance_of", { account_id: payee })) ?? "0");
  console.log(`   state ${await view<string>(clause, "get_state")}, ${payee} +${Number(payeeAfter - payeeBefore) / 1e6} USDC, ${tx(relayed.transaction.hash)}`);

  console.log("\n7. Close it and get the deposit back");
  const before = BigInt((await provider.viewAccount({ accountId: FACTORY })).amount);
  const closed = await me.callFunctionRaw({ contractId: clause, methodName: "close", args: {}, gas: 100n * TGAS });
  const after = BigInt((await provider.viewAccount({ accountId: FACTORY })).amount);
  console.log(`   closed, ${FACTORY} +${near(after - before)} NEAR, ${tx(closed.transaction.hash)}`);

  console.log("\n8. NEAR Intents: a dry quote to fund a clause from another chain");
  try {
    const tokens = (await (await fetch("https://1click.chaindefuser.com/v0/tokens")).json()) as Array<{ assetId: string; symbol: string; blockchain: string; contractAddress?: string }>;
    const dest = tokens.find((t) => t.blockchain === "near" && t.contractAddress === USDC);
    const origin = tokens.find((t) => t.blockchain === "base" && t.symbol === "USDC");
    if (!dest || !origin) throw new Error("token list changed");
    const quote = await fetch("https://1click.chaindefuser.com/v0/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        dry: true,
        swapType: "EXACT_OUTPUT",
        slippageTolerance: 100,
        originAsset: origin.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: dest.assetId,
        amount: "2000000",
        refundTo: "0x0000000000000000000000000000000000000000",
        refundType: "ORIGIN_CHAIN",
        recipient: clause,
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });
    const q = (await quote.json()) as { quote?: { amountInFormatted?: string; amountOutFormatted?: string; timeEstimate?: number } };
    console.log(`   USDC on Base -> exactly 2 USDC into a clause on NEAR: pay ${q.quote?.amountInFormatted ?? "?"} USDC, about ${q.quote?.timeEstimate ?? "?"} s`);
  } catch (err) {
    console.log(`   quote unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
