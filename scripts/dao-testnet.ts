/**
 * Put the testnet factory under a Sputnik DAO, then change the mandate by a vote.
 *
 *   npm run dao:testnet
 *
 * Safe to run again: each step checks the chain first and skips what is done.
 *   1. create the DAO `clausehold-council.sputnikv2.testnet`, with one council
 *      member and a 1-of-1 vote, so a proposal passes as soon as it is approved
 *   2. the factory's current owner hands ownership to the DAO (`set_owner`)
 *   3. a council member proposes `set_mandate` on the factory, making the DAO the
 *      mandate's co-signer for disputes, and votes for it; the DAO calls the factory
 *   4. read back the owner, the mandate and the proposal from chain
 *
 * Costs, all test NEAR: about 6 to create the DAO (it stays in the DAO's own
 * account), a 0.1 proposal bond (returned when the proposal passes), and gas.
 *
 * Env:
 *   CLAUSEHOLD_DAO_COUNCIL   council member and proposer (default clausehold-ops.testnet)
 *   CLAUSEHOLD_DAO_NAME      DAO name under sputnikv2.testnet (default clausehold-council)
 * Keys are read from ~/.near-credentials/testnet/<account>.json.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

const SPUTNIK = "sputnikv2.testnet";
const FACTORY = "clausehold.testnet";
const COUNCIL = process.env.CLAUSEHOLD_DAO_COUNCIL ?? "clausehold-ops.testnet";
const NAME = process.env.CLAUSEHOLD_DAO_NAME ?? "clausehold-council";
const DAO = `${NAME}.${SPUTNIK}`;

const NEAR = 10n ** 24n;
const CREATE_DEPOSIT = 6n * NEAR;
const PROPOSAL_BOND = NEAR / 10n;
const TGAS = 10n ** 12n;

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });

function signer(accountId: string): Account {
  const file = join(homedir(), ".near-credentials", "testnet", `${accountId}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  return new Account(accountId, provider, private_key as KeyPairString);
}

async function exists(accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

const view = <T>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider.callFunction({ contractId, method, args }) as Promise<T>;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

interface Mandate {
  allowed_assets: string[];
  max_per_clause: string;
  per_payee_daily_cap: string;
  daily_cap: string;
  new_payee_ceiling: string;
  paused: boolean;
  cosigner: string | null;
  creators?: string[];
}

async function main() {
  console.log(`DAO ${DAO}\nCouncil ${COUNCIL}\nFactory ${FACTORY}`);
  const council = signer(COUNCIL);

  console.log("\n1. The DAO");
  if (await exists(DAO)) {
    console.log("   already exists");
  } else {
    const policy = {
      roles: [
        { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
        { name: "council", kind: { Group: [COUNCIL] }, permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"], vote_policy: {} },
      ],
      default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
      proposal_bond: PROPOSAL_BOND.toString(),
      proposal_period: (7n * 24n * 3600n * 10n ** 9n).toString(),
      bounty_bond: PROPOSAL_BOND.toString(),
      bounty_forgiveness_period: (24n * 3600n * 10n ** 9n).toString(),
    };
    const config = { name: NAME, purpose: "Sets the spending rules for Clausehold clauses and settles disputes.", metadata: "" };
    const r = await council.callFunctionRaw({ contractId: SPUTNIK, methodName: "create", args: { name: NAME, args: b64({ config, policy }) }, deposit: CREATE_DEPOSIT, gas: 300n * TGAS });
    if (!(await exists(DAO))) throw new Error(`The DAO was not created (tx ${r.transaction.hash})`);
    console.log(`   created, tx ${r.transaction.hash}`);
  }

  console.log("\n2. The factory's owner");
  const owner = await view<string>(FACTORY, "get_owner");
  if (owner === DAO) {
    console.log("   already the DAO");
  } else {
    const r = await signer(owner).callFunctionRaw({ contractId: FACTORY, methodName: "set_owner", args: { owner: DAO }, gas: 30n * TGAS });
    const now = await view<string>(FACTORY, "get_owner");
    if (now !== DAO) throw new Error(`Owner is still ${now} (tx ${r.transaction.hash})`);
    console.log(`   ${owner} handed it to the DAO, tx ${r.transaction.hash}`);
  }

  console.log("\n3. Change the mandate by a vote");
  const current = await view<Mandate | null>(FACTORY, "get_mandate");
  if (!current) throw new Error("The factory has no mandate yet; deploy.sh sets one");
  if (current.cosigner === DAO) {
    console.log("   the DAO is already the co-signer, nothing to vote on");
  } else {
    const mandate: Mandate = { ...current, cosigner: DAO };
    const kind = {
      FunctionCall: {
        receiver_id: FACTORY,
        actions: [{ method_name: "set_mandate", args: b64({ mandate }), deposit: "0", gas: (30n * TGAS).toString() }],
      },
    };
    const before = await view<number>(DAO, "get_last_proposal_id");
    const added = await council.callFunctionRaw({
      contractId: DAO,
      methodName: "add_proposal",
      args: { proposal: { description: "Make this DAO the co-signer that settles Clausehold disputes. Caps, assets and the new-payee ceiling stay as they are.", kind } },
      deposit: PROPOSAL_BOND,
      gas: 50n * TGAS,
    });
    const id = before;
    console.log(`   proposal ${id} added, tx ${added.transaction.hash}`);
    const voted = await council.callFunctionRaw({ contractId: DAO, methodName: "act_proposal", args: { id, action: "VoteApprove", proposal: kind }, gas: 200n * TGAS });
    console.log(`   approved, tx ${voted.transaction.hash}`);
  }

  console.log("\n4. Read it back from chain");
  const finalOwner = await view<string>(FACTORY, "get_owner");
  const finalMandate = await view<Mandate>(FACTORY, "get_mandate");
  const lastId = await view<number>(DAO, "get_last_proposal_id");
  const proposal = lastId > 0 ? await view<{ id: number; status: string; description: string }>(DAO, "get_proposal", { id: lastId - 1 }) : null;
  console.log(`   factory owner     ${finalOwner}`);
  console.log(`   mandate cosigner  ${finalMandate.cosigner}`);
  if (proposal) console.log(`   proposal ${proposal.id}        ${proposal.status}`);
  if (finalOwner !== DAO || finalMandate.cosigner !== DAO) throw new Error("The factory is not under the DAO yet");
  console.log("\nDone: the mandate now changes only by a vote of the DAO.");
}

main().catch((err) => {
  console.error(`\nStopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
