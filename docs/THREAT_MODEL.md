# Threat model

This is what Clausehold protects, who might attack it, what stops them, and what it does not protect against. Every claim about the contracts points at a guard in `contracts/` and a test that exercises it. Where something is a known weakness, it says so.

## What is being protected

1. **The money in a clause.** Tokens sitting in `r-<n>.<factory>` must leave only to the payee after a valid delivery, or to the buyer after expiry or a settled dispute.
2. **The treasury behind the mandate.** No clause may break the mandate's caps, asset list or new-payee ceiling, whoever proposes it.
3. **The record.** Receipts and standing must reflect what actually happened on chain, so a payee's track record cannot be inflated or erased.

## Who is involved

| actor | can do | trusted for |
|---|---|---|
| Buyer | write and fund a clause from their own wallet, freeze inside a review window, vote in a dispute | nothing beyond their own money |
| Payee | hold the worker key for one clause and submit a delivery with it | nothing |
| Desk (our API) | check clauses before signing, store invites, relay deliveries, run the website | availability only, never custody |
| Factory owner | set the mandate, change the code used for future clauses, hand ownership to a DAO | the mandate's content |
| Mandate co-signer | break a tie when a buyer freezes a clause | fairness in disputes, only when a review window is used |
| Anyone else | call the public methods: `sync_funding`, `release`, `expire`, `report_outcome`, and `create_clause` when the mandate leaves it open | nothing |

## Where trust stops

The chain is the authority. The desk is a convenience in front of it.

- The desk holds **no money and no key to any clause**. On the hosted desk, the buyer's wallet signs `create_clause` and the funding transfer; the desk only reads the result back from chain (`src/invites/wallet.ts`, `recordWalletClause`) before linking it.
- The desk's mandate check runs before any signature so it can name the broken rule. The same rules run inside `create_clause`, and that check is the one that counts.
- The desk's audit log is hash-chained, but it is a mirror of the chain's NEP-297 events, not the record.

## Controls, and what each defends against

### A clause account has one key, and it can only deliver

`create_clause` creates `r-<n>` with exactly one access key: a function-call key for the payee's `worker_pk`, receiver `r-<n>`, method `submit_delivery`, no deposit allowed. There is no full-access key, no owner method and no withdraw method.

- Defends against: the desk, the factory owner, or anyone with the worker key draining a clause.
- Tests: `worker_key_can_only_call_submit_delivery` (the key cannot call another method, another contract, or move NEAR, directly or by delegate), `no_withdraw_path_after_delivery`.

### Delivery must come from the clause account itself

`submit_delivery` requires `predecessor == current_account_id`, which is only true when the worker's function-call key signed it, either directly or as a NEP-366 delegate that someone else relays. The contract never reads `signer_account_pk`.

- Defends against: anyone else claiming delivery, including the desk.
- Tests: `direct_submit_delivery_from_any_other_account_fails` (`ONLY_WORKER_KEY`), `happy_path_relayed_delivery_releases_in_same_call`.

### Tokens can only go to two fixed accounts

`buyer` and `payee` are written into the clause when it is created and never change. Every payout path (release, expire, cosign, sweep) sends to one of them. `ft_on_transfer` accepts only the configured token (`WRONG_ASSET`) and refunds anything above the clause amount.

- Defends against: redirecting money after the fact. A stolen worker key can at worst claim delivery early, and the money still goes to the payee.

### Payouts are retryable, never half-done

Each payout runs `storage_deposit` → callback → `ft_transfer` → callback, and the state changes only in the last callback, which also reports to the factory. A failure anywhere logs `clause_settle_failed` and leaves the clause as it was, with `settling` cleared, so anyone can retry.

- Defends against: money stuck because a receiver was not registered with the token, or a transfer failed midway.
- Test: `failed_ft_transfer_leaves_clause_retryable`.

### Expiry needs nobody's permission

After the deadline, if nothing was delivered, anyone may call `expire` and the whole balance goes to the buyer. Before the deadline it fails (`NOT_EXPIRED`). In a settled clause, `sync_funding` sends any late or extra deposit to the buyer.

- Defends against: a payee who disappears or loses their key, and a desk that goes offline. The money never needs us to come back.
- Test: `expire_returns_to_buyer_and_frees_reservation`.

### The mandate is enforced on chain

`create_clause` checks, in order: paused, creators, allowed assets, per-clause cap, new-payee ceiling, per-payee daily cap, daily cap. It panics with `MANDATE:<rule>`, so nothing is created. The amount is reserved against the day's caps at creation; a return gives the reservation back, a release keeps it counted.

- Defends against: an agent, a buggy desk or a direct contract call spending past the treasury's rules.
- Test: `over_mandate_create_panics_and_reservation_blocks_next`.

### Standing can only be written by real clauses

`record_outcome` on the factory accepts calls only from the clause account `r-<id>` it created, so receipts and standing cannot be forged by anyone else.

- Test: `record_outcome_only_from_own_clause`.

### Disputes need two signatures

With a review window above zero and a co-signer in the mandate, the buyer may `freeze` a delivered clause inside the window. A frozen clause moves only when the buyer and the co-signer cast the same vote with `cosign`.

- Defends against: a buyer taking back money for delivered work on their own.
- Test: `freeze_then_cosign_returns_to_buyer`.

### The payee needs no wallet, and the key cannot hurt them

The payee's browser makes the worker key, from a passkey where the browser supports it, otherwise from a secure random seed. The desk relays the signed delivery and pays the gas. The relayer validates the delegate (one `submit_delivery` action, sender and receiver both the clause, zero deposit) before spending gas on it, and the chain rejects anything else regardless.

## Known weaknesses

These are real, and some of them matter before a treasury uses this with real money.

1. **Cap griefing while `creators` is empty.** On testnet the mandate leaves `creators` empty, so anyone may call `create_clause`, naming any buyer, without funding it. Each unfunded clause still reserves its amount against that UTC day's caps. Someone willing to lock about 1.97 NEAR per clause could fill a treasury's daily cap for the rest of the day. The fix exists: set `creators` in the mandate to the accounts allowed to write clauses. A real treasury should always set it, and mainnet does. Next version (branch `claude/fund-time-caps`, not deployed yet): every new clause gets a 10 minute funding window. After it, an unfunded clause refuses deposits and anyone may call `cancel_unfunded`, which reports `cancelled` to the factory: the reservation goes back to the day's caps, and neither side's standing changes. Filling the caps then means paying the deposit again every 10 minutes. Counting the caps at funding rather than at creation, and a per-buyer daily cap, would close it fully.
2. **A delivery is a hash, not proof of good work.** The contract checks who delivered, not what was delivered. A buyer can attach an acceptance check (a page must contain text, a pull request must be merged, or the delivery must be an exact file), and the desk refuses to relay a delivery that fails it. That check lives in the desk, not the contract: a worker could relay a failing delivery through another relayer, and with a review window of zero it would pay. Buyers who need a hard stop set a review window and a co-signer as well.
3. **The co-signer is trusted in disputes.** If the buyer and the co-signer collude, they can return a frozen clause even though the work was good. A payee should look at who the co-signer is before accepting. A DAO as co-signer spreads that trust.
4. **The buyer's wallet signs what the desk prepares.** On the hosted desk, the `create_clause` arguments come from our API. A compromised API could hand the wallet a different payee or amount. The wallet shows the call before signing, and the desk checks the result on chain afterwards, but the buyer is the last line of defence: check the payee and amount in the wallet prompt.
5. **The worker key lives in the browser.** It is kept in that browser's storage. Malicious code running on the site could read it, but the key can only claim delivery, and the money still goes to the payee. Clearing the browser loses the key; the clause then expires and returns.
6. **The worker key can spend a little of the clause's NEAR.** It carries a 0.05 NEAR gas allowance so a payee can deliver directly without the relayer. Failed direct calls could burn up to that much of the clause's own NEAR, never its tokens.
7. **Storage NEAR is a deposit while the clause runs.** Each clause locks about 1.97 NEAR to store its code. Once it settles and the factory has recorded the outcome, anyone may call `close`: the clause leaves the token, deletes its own account, and the NEAR goes back to the buyer. The token step fails while any balance is left, so tokens can never be stranded in a deleted account. A closed clause's receipt lives on in the factory's record. Clauses written before `close` existed (r-0 to r-2 on testnet) keep their accounts.
8. **The factory owner controls future rules.** The owner can change the mandate and the code used for new clauses. Existing clauses keep their code and their buyer, payee and co-signer, but a malicious owner could loosen the caps for new ones. On testnet the owner is the Sputnik DAO `clausehold-council.sputnikv2.testnet`, so these changes need a passed proposal. It has one council member for the demo, which makes the DAO only as strong as that one key until more members join.
9. **Funding from other chains trusts NEAR Intents.** On mainnet, a deposit from another chain sits with the 1Click and solver network until it is delivered to the clause on NEAR. Quotes are exact-output, so the clause receives exactly its amount, and refunds land on NEAR, but that leg is outside our contracts.
10. **NEAR AI writes notes, it does not decide.** The note's hash may be stored with a delivery, but no model output ever moves money. A wrong or misleading note changes nothing on chain.

## Assumptions

- NEAR enforces function-call key permissions and NEP-366 delegate actions as specified.
- The token contract follows NEP-141 and NEP-145. On testnet, `musd.clausehold.testnet` is a test token that anyone can mint, so testnet balances prove the flow, not value.
- Block timestamps are accurate enough for deadlines measured in minutes.
- Whoever holds the factory owner key acts in the treasury's interest until ownership moves to a DAO.
