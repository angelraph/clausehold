# For judges

Clausehold holds a payment for one job in a NEAR account that exists only for that job. The account's only key belongs to the worker and can do one thing: submit the delivery. Delivery pays the worker; the deadline returns the money to the buyer. Every paid job raises the worker's on-chain standing, and that standing is what unlocks bigger jobs.

Everything below runs on NEAR testnet and costs nothing.

## Five minutes

**1. Run every claim at once (about 3 minutes).**

```bash
npm install
```

```bash
npm run judge
```

It needs a funded testnet account whose key is in `~/.near-credentials/testnet` for the buyer, and one for the worker (`CLAUSEHOLD_JUDGE_BUYER`, `CLAUSEHOLD_JUDGE_WORKER`). It sends real transactions and prints `PASS` or `FAIL` for each line below, with explorer links. Both clause deposits come back when the clauses close.

**2. Watch two AI agents do a job through MCP.**

```bash
npm run mcp:demo
```

Two copies of the Clausehold MCP server, a buyer agent and a worker agent, each with its own account. To use it from Claude Code: `claude mcp add clausehold -e CLAUSEHOLD_AGENT_ACCOUNT=you.testnet -- npx tsx src/mcp/server.ts`.

**3. Click through it.** https://clausehold.vercel.app on Testnet: connect a wallet, get test tokens on the Faucet page, write a clause, accept it from the invite link with a passkey, fund it, deliver, and close. The [Standing page](https://clausehold.vercel.app/standing) ranks payees from the factory's receipts.

## What `npm run judge` proves

| claim | how it is checked | reason code |
|---|---|---|
| over-mandate jobs are refused before anyone signs | the desk answers VETO for 40 | `maxPerClause` |
| a payee with no paid jobs is capped | VETO for 12 to an account with 0 released clauses | `newPayeeCeiling` |
| limits are earned | the same 12 passes for an account with released clauses on chain | |
| the contract enforces the mandate itself | a direct `create_clause` for 40, and for 12 to the new payee | `MANDATE:max_per_clause`, `MANDATE:new_payee_ceiling` |
| only the DAO changes the rules | `set_mandate` from another account | `ONLY_OWNER` |
| standing cannot be forged | `record_outcome` from an account that is not the clause | `ONLY_OWN_CLAUSE` |
| the clause account has exactly one key, a function-call key | access-key list read from chain | |
| nobody but the worker key can mark it delivered | the buyer calls `submit_delivery` | `ONLY_WORKER_KEY` |
| the money cannot be taken back early | `expire` before the deadline | `NOT_EXPIRED` |
| an unsettled clause cannot be closed | `close` while funded | `NOT_TERMINAL` |
| only the buyer may freeze | `freeze` from the worker | `ONLY_BUYER` |
| the worker key cannot move NEAR | a transfer signed by the worker key | protocol: needs full access |
| the worker key cannot call other methods | `expire` signed by the worker key | protocol: method not allowed |
| the worker key cannot call other contracts | a call to the token signed by the worker key | protocol: receiver mismatch |
| delivery is gasless and pays at once | the worker's delegate is relayed; its balance rises by exactly 2 | |
| standing rises with each paid job | factory `standing` before and after | |
| the storage deposit comes back | `close` deletes the account; the buyer's NEAR rises by about 1.99 | |
| a late delivery is refused | delivery after the deadline | `DEADLINE_PASSED` |
| anyone can return an undelivered job | the worker calls `expire`; the buyer gets the 2 back | |

## Tests

- Contracts: `cd contracts && cargo test -p clause -p factory` (40 clause and 26 factory unit tests). `cargo test -p sandbox-tests` runs 10 flows in a local sandbox on Linux or macOS.
- Desk and API: `npm test` (223 tests).

## On chain

- Factory: `clausehold.testnet`, owned by the Sputnik DAO `clausehold-council.sputnikv2.testnet`. Proposal 0 set the mandate's co-signer; proposal 1 uploaded the current clause code.
- Every clause is `r-<n>.clausehold.testnet`. The README lists the transactions of clauses written from a browser wallet, by MCP agents, and by this judge run.

## Known limits

- Testnet by default. NEAR Intents funding exists only on mainnet; on testnet clauses are funded with the test token mUSD.
- A delivery is a hash. The contract checks who delivered, not how good the work is. Buyers who want to check set a review window, and the DAO co-signer settles disputes.
- While the testnet mandate leaves `creators` open, anyone can write unfunded clauses that reserve a day's caps. A real treasury sets `creators`. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
