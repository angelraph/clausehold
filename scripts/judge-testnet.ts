/**
 * Everything a judge needs to see, in one command, on NEAR testnet.
 *
 *   npm run judge
 *
 * It runs real transactions and prints a pass/fail line for each claim:
 *   A. the desk refuses over-mandate jobs before anyone signs, and earned standing lifts a limit
 *   B. the factory refuses the same things on chain, and only the DAO may change the rules
 *   C. one full job: written and funded by the buyer, attacked while funded, delivered
 *      without gas, paid, then closed so the storage NEAR comes back
 *   D. one job left to expire: a late delivery is refused, anyone returns the money, then it closes
 *
 * Every attack must fail with its exact reason code. Costs only test NEAR and
 * test mUSD; both clause deposits come back when the clauses close.
 *
 * Env: CLAUSEHOLD_JUDGE_BUYER (default clausehold-ops.testnet) and
 * CLAUSEHOLD_JUDGE_WORKER (default clausehold.testnet), keys in ~/.near-credentials/testnet.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, KeyPair, type KeyPairString } from "near-api-js";
import { acceptJob, agentAccount, agentEnv, checkPayee, closeJob, deliver, jobStatus, openJob, provider, toBase6, writeAndFund } from "../src/agent/index.js";

const env = agentEnv();
const BUYER = process.env.CLAUSEHOLD_JUDGE_BUYER ?? "clausehold-ops.testnet";
const WORKER = process.env.CLAUSEHOLD_JUDGE_WORKER ?? "clausehold.testnet";
const NEW_PAYEE = "musd.clausehold.testnet"; // a real account that has never been paid through a clause
const TGAS = 10n ** 12n;
const tx = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

let passed = 0;
let failed = 0;
function ok(label: string, evidence = "") {
  passed++;
  console.log(`  PASS  ${label}${evidence ? `\n        ${evidence}` : ""}`);
}
function bad(label: string, why: string) {
  failed++;
  console.log(`  FAIL  ${label}\n        ${why}`);
}
function section(t: string) {
  console.log(`\n${t}`);
}

/** The attempt must fail, and its error must carry the expected code. */
async function refused(label: string, code: RegExp, attempt: () => Promise<unknown>) {
  try {
    await attempt();
    bad(label, "it went through");
  } catch (err) {
    const msg = err instanceof Error ? `${err.message} ${JSON.stringify((err as { cause?: unknown }).cause ?? "")}` : String(err);
    const hit = msg.match(code);
    if (hit) ok(label, `refused: ${msg.slice(Math.max(0, (hit.index ?? 0) - 40), (hit.index ?? 0) + hit[0].length + 40).replace(/\s+/g, " ").trim()}`);
    else bad(label, `refused, but not with ${code}: ${msg.slice(0, 220)}`);
  }
}

async function nearOf(account: string): Promise<bigint> {
  return BigInt((await provider(env).viewAccount({ accountId: account })).amount);
}
const near = (y: bigint) => (Number(y / 10n ** 20n) / 1e4).toFixed(4);

function workerSecret(inviteId: string): string {
  const f = join(env.workerKeyDir, `${inviteId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  return (JSON.parse(readFileSync(f, "utf8")) as { secretKey: string }).secretKey;
}

async function main() {
  const buyer = agentAccount(BUYER, env);
  const worker = agentAccount(WORKER, env);
  console.log(`Clausehold judge run on ${env.network}\nfactory ${env.factory}, desk ${env.desk}\nbuyer ${BUYER}, worker ${WORKER}`);

  // ------------------------------------------------------------------ A
  section("A. The desk checks every job before anyone signs");
  const tooBig = await openJob({ buyer: BUYER, payee: WORKER, amount: 40, terms: "judge: over the per-clause cap", agentId: "judge" }, env);
  tooBig.decision === "VETO" && tooBig.reasons.some((r) => r.rule === "maxPerClause" && r.outcome === "violated")
    ? ok("40 is refused by maxPerClause", tooBig.reasons.find((r) => r.rule === "maxPerClause")?.detail)
    : bad("40 is refused by maxPerClause", `got ${tooBig.decision}`);
  const fresh = await checkPayee(NEW_PAYEE, env);
  const newcomer = await openJob({ buyer: BUYER, payee: NEW_PAYEE, amount: 12, terms: "judge: new payee above the ceiling", agentId: "judge" }, env);
  newcomer.decision === "VETO" && newcomer.reasons.some((r) => r.rule === "newPayeeCeiling" && r.outcome === "violated")
    ? ok(`12 for ${NEW_PAYEE} (${fresh.released} released) is refused by newPayeeCeiling`, newcomer.reasons.find((r) => r.rule === "newPayeeCeiling")?.detail)
    : bad("12 for a new payee is refused", `got ${newcomer.decision}`);
  const proven = await checkPayee(WORKER, env);
  const earned = await openJob({ buyer: BUYER, payee: WORKER, amount: 12, terms: "judge: earned standing lifts the ceiling", minutes: 1, agentId: "judge" }, env);
  earned.decision === "PASS"
    ? ok(`the same 12 for ${WORKER} (${proven.released} released) passes: limits are earned`, earned.reasons.find((r) => r.rule === "newPayeeCeiling")?.detail)
    : bad("12 for a proven payee passes", `got ${earned.decision}`);

  // ------------------------------------------------------------------ B
  section("B. The factory enforces the same rules on chain");
  const deposit = BigInt((await provider(env).callFunction({ contractId: env.factory, method: "create_deposit", args: {} })) as string);
  const direct = (payee: string, amount: number) =>
    buyer.callFunctionRaw({
      contractId: env.factory,
      methodName: "create_clause",
      args: {
        buyer: BUYER,
        payee,
        worker_pk: KeyPair.fromRandom("ed25519").getPublicKey().toString(),
        asset: env.token,
        amount: toBase6(amount).toString(),
        deadline: Math.floor(Date.now() / 1000) + 3600,
        terms_hash: "judge-direct-call",
        challenge_secs: 0,
      },
      deposit,
      gas: 300n * TGAS,
    });
  await refused("a direct create_clause for 40 panics", /MANDATE:max_per_clause/, () => direct(WORKER, 40));
  await refused(`a direct create_clause for 12 to ${NEW_PAYEE} panics`, /MANDATE:new_payee_ceiling/, () => direct(NEW_PAYEE, 12));
  const mandate = await provider(env).callFunction({ contractId: env.factory, method: "get_mandate", args: {} });
  await refused("set_mandate from anyone but the DAO is refused", /ONLY_OWNER/, () =>
    buyer.callFunctionRaw({ contractId: env.factory, methodName: "set_mandate", args: { mandate }, gas: 30n * TGAS })
  );
  await refused("record_outcome from anyone but the clause itself is refused", /ONLY_OWN_CLAUSE/, () =>
    buyer.callFunctionRaw({ contractId: env.factory, methodName: "record_outcome", args: { id: 1, outcome: "released", paid: "1" }, gas: 30n * TGAS })
  );

  // ------------------------------------------------------------------ C
  section("C. One job, start to finish, attacked while the money is held");
  const deliverable = "intro-30s.mp4, cut at 00:00 to 00:30";
  const expected = createHash("sha256").update(deliverable).digest("hex");
  const job = await openJob(
    { buyer: BUYER, payee: WORKER, amount: 2, terms: "judge: cut intro.mp4 to 30 seconds", minutes: 30, agentId: "judge", check: { kind: "sha256", value: expected } },
    env
  );
  if (!job.inviteId) throw new Error(`The main job did not clear: ${job.decision}`);
  const accepted = await acceptJob(job.inviteId, env);
  ok("the worker made its job key and bound it", accepted.publicKey);
  const funded = await writeAndFund(buyer, job.inviteId, env);
  ok(`the buyer's own key wrote ${funded.clause} and funded it`, `${tx(funded.createTx)}\n        ${tx(funded.fundTx)}`);
  const keys = await provider(env).viewAccessKeyList({ accountId: funded.clause });
  const only = keys.keys.length === 1 && typeof keys.keys[0]?.access_key.permission !== "string";
  only ? ok("the clause account has exactly one key, a function-call key", keys.keys[0]?.public_key) : bad("one function-call key only", JSON.stringify(keys.keys));

  const clause = funded.clause;
  await refused("the buyer cannot mark it delivered", /ONLY_WORKER_KEY/, () =>
    buyer.callFunctionRaw({ contractId: clause, methodName: "submit_delivery", args: { hash: "fake" }, gas: 200n * TGAS })
  );
  await refused("nobody can take the money back before the deadline", /NOT_EXPIRED/, () =>
    worker.callFunctionRaw({ contractId: clause, methodName: "expire", args: {}, gas: 150n * TGAS })
  );
  await refused("an unsettled clause cannot be closed", /NOT_TERMINAL/, () => buyer.callFunctionRaw({ contractId: clause, methodName: "close", args: {}, gas: 100n * TGAS }));
  await refused("only the buyer could ever freeze it", /ONLY_BUYER/, () => worker.callFunctionRaw({ contractId: clause, methodName: "freeze", args: {}, gas: 30n * TGAS }));
  const asClause = new Account(clause, provider(env), workerSecret(job.inviteId) as KeyPairString);
  await refused("the worker key cannot move NEAR out of the clause", /RequiresFullAccess|full access|FunctionCall/i, () => asClause.transfer({ receiverId: WORKER, amount: 1n }));
  await refused("the worker key cannot call anything but submit_delivery", /MethodNameMismatch|does not allow method|not allowed/i, () =>
    asClause.callFunctionRaw({ contractId: clause, methodName: "expire", args: {}, gas: 10n * TGAS })
  );
  await refused("the worker key cannot call another contract", /ReceiverMismatch|receiver/i, () =>
    asClause.callFunctionRaw({ contractId: env.token, methodName: "ft_balance_of", args: { account_id: WORKER }, gas: 10n * TGAS })
  );

  const workerBefore = BigInt((await provider(env).callFunction({ contractId: env.token, method: "ft_balance_of", args: { account_id: WORKER } })) as string);
  await refused("a delivery that fails the buyer's acceptance check is never relayed", /acceptance check failed[^.]*/, () => deliver(job.inviteId as string, "the wrong file", env));
  const done = await deliver(job.inviteId, deliverable, env);
  const workerAfter = BigInt((await provider(env).callFunction({ contractId: env.token, method: "ft_balance_of", args: { account_id: WORKER } })) as string);
  workerAfter - workerBefore === toBase6(2)
    ? ok("the right file passed the check; the worker delivered with no gas and was paid 2 mUSD in the same transaction", tx(done.txHash))
    : bad("the worker was paid", `balance moved by ${workerAfter - workerBefore}`);
  const after = await checkPayee(WORKER, env);
  after.released === proven.released + 1 ? ok(`the worker's standing rose from ${proven.released} to ${after.released} released`) : bad("standing rose", `${proven.released} -> ${after.released}`);
  const before = await nearOf(BUYER);
  const closed = await closeJob(buyer, clause, env);
  const back = (await nearOf(BUYER)) - before;
  closed.closed ? ok(`closed: the account is gone and the buyer got ${near(back)} NEAR back after the fee`, tx(closed.txHash)) : bad("closed", "the account still exists");

  // ------------------------------------------------------------------ D
  section("D. A job nobody delivers comes back to the buyer");
  const late = await openJob({ buyer: BUYER, payee: WORKER, amount: 2, terms: "judge: a job left to expire", minutes: 1, agentId: "judge" }, env);
  if (!late.inviteId) throw new Error(`The expiry job did not clear: ${late.decision}`);
  await acceptJob(late.inviteId, env);
  const lateFunded = await writeAndFund(buyer, late.inviteId, env);
  ok(`${lateFunded.clause} written and funded, with a 1 minute deadline`, tx(lateFunded.fundTx));
  const status = await jobStatus(late.inviteId, env);
  const wait = new Date(status.deadline).getTime() - Date.now() + 8000;
  console.log(`        waiting ${Math.max(0, Math.round(wait / 1000))} s for the deadline`);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  await refused("a delivery after the deadline is refused", /DEADLINE_PASSED|refused the delivery/, () => deliver(late.inviteId as string, "too late", env));
  const buyerTokensBefore = BigInt((await provider(env).callFunction({ contractId: env.token, method: "ft_balance_of", args: { account_id: BUYER } })) as string);
  const expired = await worker.callFunctionRaw({ contractId: lateFunded.clause, methodName: "expire", args: {}, gas: 150n * TGAS });
  const buyerTokensAfter = BigInt((await provider(env).callFunction({ contractId: env.token, method: "ft_balance_of", args: { account_id: BUYER } })) as string);
  buyerTokensAfter - buyerTokensBefore === toBase6(2)
    ? ok("anyone (here the worker) called expire, and the 2 mUSD went back to the buyer", tx(expired.transaction.hash))
    : bad("expire returned the money", `buyer moved by ${buyerTokensAfter - buyerTokensBefore}`);
  const lateClosed = await closeJob(buyer, lateFunded.clause, env);
  lateClosed.closed ? ok("the returned clause closed, and its deposit went back to the buyer", tx(lateClosed.txHash)) : bad("returned clause closed", "still exists");

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
