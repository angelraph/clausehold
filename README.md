# Clausehold

Pay a person or an agent for a finished job, on NEAR.

The money is held under a clause, and the clause is the only key that moves it. When the work is delivered, it goes to the person who did it. When the deadline passes first, it goes back to whoever paid.

- Live site: https://clausehold.vercel.app (Testnet by default, switch at the top)
- Testnet factory: [`clausehold.testnet`](https://testnet.nearblocks.io/address/clausehold.testnet)
- Built for NEAR HACKATHON, November 2026. Tracks: agents, realworld, social, security.

## The problem

A studio, a DAO or an AI agent wants to pay someone for a piece of work: a 30 second cut, a translation, a bug fix. Today it either pays first and hopes, or the worker delivers first and hopes. An escrow service fixes that by holding the money, which means trusting the escrow service.

Clausehold holds the money in a NEAR account that exists for one job only. That account has no owner key. Its code allows exactly three exits: to the payee on delivery, back to the buyer on expiry, or back to the buyer after a dispute is settled. Nobody, including us, can take it anywhere else.

## Try it in five minutes

Everything below is on testnet, so it is free.

**1. Get a wallet and test tokens.** Open https://clausehold.vercel.app/faucet.
- Connect any NEAR wallet (HOT, Meteor, MyNearWallet, Intear and others are listed).
- Get test NEAR from the faucet link on that page.
- Click **Get 100 mUSD**. You should see your mUSD balance go to 100. mUSD is our test dollar token.

**2. Write a clause.** Go to **Write a clause**.
- Payee: any testnet account you control, or `clausehold.testnet`.
- Amount: `2`. Expires after: `30`. Review window: `0`.
- Click **Check and open an invite**. You should see **Cleared**, every mandate rule listed with a tick, and an invite link.

**3. Accept as the payee.** Open the invite link in a new tab of the same browser and click **Accept with a passkey**. Your browser makes a key. It is the only key the clause will ever accept, and it can do one thing: submit a delivery. The page shows your new key and says it is waiting for the buyer to write the clause.

**4. Write it on chain.** Back on the clause page, click **Write the clause** and approve it in your wallet. You should see a new account `r-<n>.clausehold.testnet`. Open it on the explorer: it has exactly one access key, a function-call key limited to `submit_delivery`.

**5. Fund it.** Click **Fund 2.00 mUSD** and approve. The clause now holds 2 mUSD and shows **Funded**.

**6. Deliver.** On the invite tab, attach any file or type a note and click **Submit delivery**. There is no wallet prompt and no gas to pay: the passkey signs, and the desk relays it. You should see **Paid**, and the payee's mUSD goes up by 2.

**7. Check the record.** Open the **Desk**. The clause shows **Released**. Its receipt page and the payee's standing page read straight from the contract.

To see a refusal, go back to step 2 and ask for `12`. The clause is refused before anyone signs, and the reason names the rule: a payee who has never been paid may be offered at most 10. Ask for `40` and the per-clause cap of 25 refuses it too. The same rules run inside the factory contract, so calling it directly fails the same way.

## What it looks like on chain

A real run from the website with a browser wallet, clause [`r-2.clausehold.testnet`](https://testnet.nearblocks.io/address/r-2.clausehold.testnet):

| step | transaction |
|---|---|
| buyer's wallet calls `create_clause`; the factory creates `r-2`, deploys its code and adds the one worker key | [`93YxwwVK…`](https://testnet.nearblocks.io/txns/93YxwwVKrYgrHBmQtd1PY3mxMRGVwcy5B8vVeeXbAJdB) |
| buyer's wallet sends 2 mUSD with `ft_transfer_call`; the clause keeps it and turns Funded | [`14EjWX8W…`](https://testnet.nearblocks.io/txns/14EjWX8WLB5tJd3NrzMVAXgwc2GSexV9cDL2xz6pkiYK) |
| the payee's key signs `submit_delivery` as a meta-transaction, the desk relays it, the clause pays the payee and reports to the factory, all in one transaction | [`HxM4eEim…`](https://testnet.nearblocks.io/txns/HxM4eEimA3NKVw9JBtDqfvDQEhGkhUdFnqiKdxW4vKer) |

Clause `r-3` went the same way and was then closed: the account deleted itself and its 1.99 NEAR of storage went back to the buyer in [`2smpAzwS…`](https://testnet.nearblocks.io/txns/2smpAzwSx89XfeesJdrbriXEjFQzCyH8PkLNBhfbf9tN). Its receipt now comes from the factory's record.

And one that ran out of time, clause [`r-0`](https://testnet.nearblocks.io/address/r-0.clausehold.testnet): after its deadline anyone may call `expire`, and the 2 mUSD went back to the buyer in [`Eu2Kpjyg…`](https://testnet.nearblocks.io/txns/Eu2KpjygiTzDFsBCeuxhEmMtTkuJ3K43uuAkunnXi72p).

## Why NEAR

Each of these does real work in the design. Take one away and the product stops working.

- **Sub-accounts.** Every job gets its own account, `r-<n>.clausehold.testnet`. Its balance is the job's money and nothing else, so it is easy to audit and impossible to mix up with other jobs.
- **Function-call access keys.** The only key on a clause account is the payee's key, limited to calling `submit_delivery` on that one account with no deposit. It cannot transfer, cannot call anything else, and there is no full-access key at all.
- **Meta-transactions (NEP-366).** The payee never needs a wallet or NEAR for gas. Their key signs a delegate action and the desk relays it. The contract checks only that the call came from the clause account itself, which is true only when the worker's key signed it.
- **Fungible tokens (NEP-141).** Funding is `ft_transfer_call`; `ft_on_transfer` keeps the tokens while the clause is open and refunds anything extra. Payouts register the receiver's storage first, then transfer, and only change state in the final callback, so a failed payout can simply be retried.
- **Events (NEP-297).** Every step logs a `clausehold` event. The desk mirrors them into a hash-chained log, but the chain is the record.
- **NEAR Intents (mainnet).** A buyer can fund a clause from another chain. The 1Click quote is exact-output, so the clause receives exactly its amount on NEAR, and any refund lands on NEAR too.
- **Sputnik DAO.** The factory belongs to a DAO. A treasury votes once on the rule, not on every invoice, and the same DAO settles disputes as co-signer.
- **NEAR AI Cloud.** Turns a plain-English spending rule into a mandate and writes a short note about each delivery. It never decides whether money moves.

## The mandate

A treasury sets its rules once, and every clause is checked against them twice: by the desk before anyone signs, so the refusal can name the rule, and by the factory contract on chain, which is the one that counts. The testnet mandate says:

> Stablecoins only. No clause above $25. Anything above $15 needs a second person. At most $50 to any one payee a day and $200 in total a day. A payee who has never delivered gets at most $10. A clause may stay open for at most a week.

The factory reserves each clause's amount against the daily caps when it is written. A returned clause gives the reservation back; a released one keeps it counted.

### Owned by a DAO

On testnet the factory belongs to a Sputnik DAO, [`clausehold-council.sputnikv2.testnet`](https://testnet.nearblocks.io/address/clausehold-council.sputnikv2.testnet). The rule changes only when the DAO votes for a proposal that calls `set_mandate`. Disputes on new clauses are settled with the DAO as co-signer.

| step | transaction |
|---|---|
| create the DAO: one council member, a 1-of-1 vote | [`Faow7mFx…`](https://testnet.nearblocks.io/txns/Faow7mFxS4rjg9gsxNpjGmBfYzNoUqr4NKSiKvCJY95c) |
| the factory's owner hands it to the DAO with `set_owner` | [`GmxPAgH6…`](https://testnet.nearblocks.io/txns/GmxPAgH6uXHxxzGSH6GLDYZMFNdA16r9jCMXraW995cq) |
| proposal 0: make the DAO the co-signer, by calling the factory's `set_mandate` | [`5zRuj9Nb…`](https://testnet.nearblocks.io/txns/5zRuj9NbHSK7dvQkhvDUEdsZwUXfyb6SMNsg7RU6wFm5) |
| the council approves it, and the DAO calls the factory | [`FwFoGeE3…`](https://testnet.nearblocks.io/txns/FwFoGeE3EU9Y1jLhPqx8AFMoXxxttddK98UP8QnTwbdz) |

The [Mandate page](https://clausehold.vercel.app/mandate) reads the owner and the rule straight from the factory. `npm run dao:testnet` repeats these steps for another DAO; each step checks the chain first and skips what is already done.

## Run it yourself

You need Node 22 or later.

```bash
npm install
```

```bash
npm run dev -- init
```

```bash
npm run dev -- clause editor.testnet 2 --buyer studio-agent.testnet --terms "Cut intro.mp4 to 30 seconds"
```

You should see `Verdict: PASS`, ten rules ticked, and `CLEARED`. Change `2` to `12` and you get `VETO` from `newPayeeCeiling`. Change it to `40` and `maxPerClause` refuses it as well.

```bash
npm test
```

To run the desk and the website locally, start the API, then the site in a second terminal, and open http://localhost:5173:

```bash
npm run dev -- serve
```

```bash
cd web && npm install && npm run dev
```

The end-to-end script runs one full clause against the hosted testnet desk: invite, key, writing, funding, a gasless delivery and the release, then checks the payee's balance. It needs a funded testnet account whose key is in `~/.near-credentials/testnet` (set `CLAUSEHOLD_E2E_BUYER`). Each run stores one clause account on chain, which costs about 2 test NEAR.

```bash
npm run e2e:testnet
```

The contracts build and test separately; see [contracts/README.md](contracts/README.md) and the full interface in [contracts/ABI.md](contracts/ABI.md).

## For agents

An agent proposes work over HTTP. The desk answers PASS, VETO or ESCALATE before anything is signed.

| route | what it does |
|---|---|
| `POST /invites` | propose a clause; if it clears, get an invite link for the payee |
| `GET /invites/:id` | the invite and its status |
| `POST /invites/:id/key` | the payee's browser posts its public key |
| `GET /invites/:id/create` | the exact `create_clause` call for the buyer's wallet to sign |
| `POST /invites/:id/written` | report the new clause; the desk checks it on chain before linking it |
| `POST /relay` | submit the payee's signed delivery; the desk pays the gas |
| `GET /desk/clauses` | every clause and where it stands |
| `GET /mandate` | the active mandate |

The hosted testnet desk is https://clausehold-api-testnet.vercel.app. The routes above are open, because the website calls them without a key. `/relay` only ever submits a delivery that the payee's own key signed. Routes that decide something (approve, halt) or make the desk sign any other call need an API key. More examples are on the [For agents](https://clausehold.vercel.app/developers) page.

## What can go wrong, and what happens

- **The payee loses their key.** Nothing can be delivered, so after the deadline anyone may call `expire` and the money goes back to the buyer.
- **The desk goes down or turns hostile.** It holds no money and no key to any clause. The worst it can do is refuse to relay a delivery, and then the deadline returns the money. A payee can also send their signed delivery through any other relayer.
- **Someone calls `submit_delivery` directly.** It fails. Only a call from the clause account itself passes, and only the worker's function-call key can make one.
- **The work is wrong.** With a review window above zero, the buyer may `freeze` the clause after delivery. Then it moves only when the buyer and the mandate's co-signer agree.
- **Tokens arrive late or twice.** After a clause settles, `sync_funding` sends any leftover balance to the buyer.
- **A clause asks for too much.** The factory panics with the rule's name, and nothing is created.

The full threat model, with the test behind each control and the known weaknesses, is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Honest limits

- Writing a clause stores a small contract on chain, which needs about 1.97 NEAR from the buyer while the clause runs. It is a deposit, not a fee: once the clause settles, anyone can close it, and the account deletes itself and sends that NEAR back to the buyer. The buyer still needs the 2 NEAR up front.
- Funding through NEAR Intents is mainnet only, because 1Click has no testnet. On testnet, clauses are funded directly with mUSD.
- The testnet DAO has a single council member, so one vote passes a proposal. That proves the wiring; a real treasury would add its members and raise the threshold.

## What is in this repository

| path | what it is |
|---|---|
| `contracts/` | Rust: the factory, the per-job clause contract, a test token, and sandbox tests |
| `src/` | the desk: mandate checks, invites, the relayer, the NEAR and Intents clients, the audit log, the CLI |
| `web/` | the website: desk, clause pages, the payee's invite page, wallet connect, faucet |
| `scripts/e2e-testnet.ts` | one full clause against the hosted testnet desk |
| `tests/` | unit and API tests for the desk |

## Prior work, disclosed

This repository previously held **CHARTER**, a policy layer for AI trading agents on Binance, built in September 2026 for a different hackathon. Everything up to the tag `pre-hackathon` is that baseline; everything after it is Clausehold, built from November 1 for NEAR HACKATHON. The audit log, the rule-engine shape, the approval flow and the agent keys were kept and rewritten around clauses. All Binance and trading code was removed. The full diff: https://github.com/angelraph/clausehold/compare/pre-hackathon...master

Code in this repository was written with help from Claude, an AI assistant, and reviewed and run by the author.

## License

MIT
