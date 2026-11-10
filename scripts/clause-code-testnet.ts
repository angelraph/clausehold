/**
 * Upload new clause code to the testnet factory through the DAO, and refresh
 * the test token's code.
 *
 *   npm run clause-code:testnet
 *
 * The factory belongs to the DAO, so `set_clause_code` can only come from a
 * passed proposal. The proposal carries the wasm as its argument bytes. Steps,
 * each skipped when the chain already shows it done:
 *   1. redeploy the test token `musd.clausehold.testnet` (same state, new methods)
 *   2. top up the DAO if it cannot pay the storage for a proposal this large
 *   3. propose `set_clause_code` on the factory and vote for it
 *   4. read back the code hash and the new create deposit
 *
 * Costs, all test NEAR: the proposal's storage (about 2.5, held by the DAO),
 * a 0.1 bond (returned when it passes), and gas.
 *
 * Env:
 *   CLAUSEHOLD_DAO_COUNCIL   council member who proposes and votes (default clausehold-ops.testnet)
 *   CLAUSEHOLD_CLAUSE_WASM   default contracts/target/near/clause/clause.wasm
 *   CLAUSEHOLD_TOKEN_WASM    default contracts/target/near/mock-ft/mock_ft.wasm
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

const FACTORY = "clausehold.testnet";
const TOKEN = "musd.clausehold.testnet";
const COUNCIL = process.env.CLAUSEHOLD_DAO_COUNCIL ?? "clausehold-ops.testnet";
const CLAUSE_WASM = process.env.CLAUSEHOLD_CLAUSE_WASM ?? "contracts/target/near/clause/clause.wasm";
const TOKEN_WASM = process.env.CLAUSEHOLD_TOKEN_WASM ?? "contracts/target/near/mock-ft/mock_ft.wasm";

const NEAR = 10n ** 24n;
const BYTE_COST = 10n ** 19n;
const TGAS = 10n ** 12n;

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });

function signer(accountId: string): Account {
  const file = join(homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(accountId, provider, private_key as KeyPairString);
}

const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args }) as Promise<T>;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const near = (yocto: bigint) => (Number(yocto / 10n ** 20n) / 1e4).toFixed(4);

async function main() {
  const clause = new Uint8Array(readFileSync(CLAUSE_WASM));
  const token = new Uint8Array(readFileSync(TOKEN_WASM));
  const dao = await view<string>(FACTORY, "get_owner");
  console.log(`Factory ${FACTORY}, owned by ${dao}\nClause wasm ${clause.length} bytes, sha256 ${sha256(clause)}`);
  const council = signer(COUNCIL);

  console.log("\n1. The test token");
  const r1 = await signer(TOKEN).deployContract(token);
  console.log(`   redeployed (${token.length} bytes, sha256 ${sha256(token).slice(0, 12)}…), tx ${r1.transaction.hash}`);
  const bounds = await view<{ min: string }>(TOKEN, "storage_balance_bounds");
  console.log(`   still answers: storage min ${bounds.min}`);

  const info = await view<{ len: number; sha256: string } | null>(FACTORY, "clause_code_info");
  if (info?.sha256 === sha256(clause)) {
    console.log("\n2-3. The factory already has this clause code");
  } else {
    console.log("\n2. Room in the DAO for the proposal");
    const args = Buffer.from(clause).toString("base64");
    const need = BigInt(args.length + 4000) * BYTE_COST + NEAR / 2n;
    const acct = await provider.viewAccount({ accountId: dao });
    const free = BigInt(acct.amount) - BigInt(acct.storage_usage) * BYTE_COST;
    if (free < need) {
      const top = need - free;
      const t = await council.transfer({ receiverId: dao, amount: top });
      console.log(`   sent ${near(top)} NEAR to the DAO, tx ${t.transaction.hash}`);
    } else {
      console.log(`   enough already (${near(free)} NEAR free)`);
    }

    console.log("\n3. Propose set_clause_code and vote");
    const kind = {
      FunctionCall: {
        receiver_id: FACTORY,
        actions: [{ method_name: "set_clause_code", args, deposit: "0", gas: (150n * TGAS).toString() }],
      },
    };
    const policy = await view<{ proposal_bond: string }>(dao, "get_policy");
    const id = await view<number>(dao, "get_last_proposal_id");
    const added = await council.callFunctionRaw({
      contractId: dao,
      methodName: "add_proposal",
      args: { proposal: { description: `New clause code (${clause.length} bytes, sha256 ${sha256(clause)}): settled clauses can be closed to return their storage NEAR to the buyer.`, kind } },
      deposit: BigInt(policy.proposal_bond),
      gas: 300n * TGAS,
    });
    console.log(`   proposal ${id} added, tx ${added.transaction.hash}`);
    const voted = await council.callFunctionRaw({ contractId: dao, methodName: "act_proposal", args: { id, action: "VoteApprove", proposal: kind }, gas: 300n * TGAS });
    console.log(`   approved, tx ${voted.transaction.hash}`);
    const p = await view<{ status: string }>(dao, "get_proposal", { id });
    console.log(`   proposal ${id} is ${p.status}`);
  }

  console.log("\n4. Read it back from chain");
  const after = await view<{ len: number; sha256: string } | null>(FACTORY, "clause_code_info");
  const deposit = BigInt(await view<string>(FACTORY, "create_deposit"));
  console.log(`   clause code ${after?.len} bytes, sha256 ${after?.sha256}`);
  console.log(`   create deposit ${near(deposit)} NEAR`);
  if (after?.sha256 !== sha256(clause)) throw new Error("The factory does not have the new code");
  console.log("\nDone: new clauses use the new code.");
}

main().catch((err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
