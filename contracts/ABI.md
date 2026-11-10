# Clausehold contract ABI (for the TS side)

All args are JSON. Conventions:
- `U128` = decimal **string** (`"2000000"`). Base units of the FT (USDC: 6 decimals).
- `deadline`, `challenge_secs`, `created_at`, `at`, `delivered_at` = **unix seconds**, JSON **number** (u64).
- `worker_pk` = `"ed25519:<base58>"` (only ed25519 accepted).
- `asset` = the **FT contract account id** (e.g. `17208628f84f...36133a1` on mainnet, `musd.clausehold.testnet` on testnet). Never a symbol.
- Account ids are strings.
- Panics are plain strings in the failure message (`Smart contract panicked: <MSG>`).

## Factory (`clausehold.near` / `clausehold.testnet`)

### Change methods
| method | args | deposit | gas | caller |
|---|---|---|---|---|
| `new` (init) | `{owner: AccountId, mandate: Mandate \| null}` | 0 | 30 Tgas | deployer |
| `set_clause_code` | **raw wasm bytes as the call's args** (not JSON) | 0 | 300 Tgas | owner |
| `set_mandate` | `{mandate: Mandate}` | 0 | 30 Tgas | owner (the DAO) |
| `set_owner` | `{owner: AccountId}` | 0 | 30 Tgas | owner |
| `create_clause` | `{buyer, payee, worker_pk, asset, amount: U128, deadline: u64 secs, terms_hash: string, challenge_secs: u64}` | **≥ `create_deposit()` yocto** (excess refunded) | **300 Tgas** | anyone, or only `mandate.creators` if non-empty |
| `record_outcome` | `{id: u64, outcome: "released"\|"returned", paid: U128}` | 0 | — | only the clause account `r-<id>` |
| `on_clause_created`, `on_clause_registered` | callbacks | | | private |

`create_clause` returns (as the final tx value) `"r-<n>.<factory>"`, or `null` if account creation failed (the deposit is refunded and the reservation released).
Panics: `MANDATE:not_set`, `MANDATE:paused`, `MANDATE:creators`, `MANDATE:allowed_assets`, `MANDATE:max_per_clause`, `MANDATE:new_payee_ceiling`, `MANDATE:per_payee_daily_cap`, `MANDATE:daily_cap`, `AMOUNT_ZERO`, `PAYEE_NOT_NAMED`, `DEADLINE_IN_PAST`, `EMPTY_TERMS_HASH`, `WORKER_PK_NOT_ED25519`, `NO_CLAUSE_CODE`, `DEPOSIT_TOO_LOW: attach <n> yoctoNEAR`.
Mandate order of checks: paused → creators → allowed_assets → max_per_clause → new_payee_ceiling → per_payee_daily_cap → daily_cap.

`Mandate`:
```json
{ "allowed_assets": ["usdc.near"], "max_per_clause": "5000000", "per_payee_daily_cap": "10000000",
  "daily_cap": "50000000", "new_payee_ceiling": "3000000", "paused": false,
  "cosigner": "dao.sputnik-dao.near" | null, "creators": [] }
```
`creators` may be omitted (defaults to `[]` = anyone). `new_payee_ceiling` applies while `standing(payee).as_payee.released == 0`. Caps count by UTC day (`block_timestamp / 86400s`); the reservation is taken at create time. A return gives it back; a release keeps it counted.

### Views
| method | args | returns |
|---|---|---|
| `get_mandate` | `{}` | `Mandate \| null` |
| `get_owner` | `{}` | `AccountId` |
| `get_clause` | `{id: u64}` | `ClauseRecord \| null` |
| `get_clauses` | `{from_index?: u64, limit?: u64 (≤200, default 50)}` | `ClauseRecord[]` |
| `clause_count` | `{}` | u64 (next id) |
| `get_receipts` | `{account_id?: AccountId, from_index?: u32, limit?: u32}` | `Receipt[]` (buyer or payee = account; all if omitted) |
| `standing` | `{account_id}` | `Standing` |
| `usage` | `{payee}` | `{day: u64, daily_used: U128, payee_used: U128}` |
| `create_deposit` | `{}` | U128 yoctoNEAR to attach to `create_clause` |
| `clause_code_info` | `{}` | `{len: u64, sha256: hex} \| null` |

```ts
ClauseRecord = { id: number, account_id: string, buyer: string, payee: string, worker_pk: string,
  asset: string, amount: string, deadline: number, terms_hash: string, challenge_secs: number,
  created_by: string, created_at: number, day: number,
  status: "pending" | "live" | "released" | "returned" | "failed" }
Receipt = { clause_id: number, account_id: string, buyer: string, payee: string, asset: string,
  amount: string, paid: string, outcome: "released" | "returned", terms_hash: string, at: number }
RoleStats = { open: number, released: number, returned: number, released_volume: string }
Standing = { as_payee: RoleStats, as_buyer: RoleStats }
```

## Clause (`r-<n>.<factory>`)

Naming: `r-0`, `r-1`, ... (counter starts at **0**, global per factory, never reused; a failed create still burns its number).
NEAR the factory sends to each clause: `storage_byte_cost × (wasm_len + 4000) + 0.1 NEAR` (≈ wasm KB × 0.01 NEAR + 0.14 NEAR). The factory also pays 0.00125 NEAR for the clause's FT `storage_deposit` and keeps 1500 bytes × storage cost for its own records. All of this is inside `create_deposit()`.
Keys: exactly one, a FunctionCall key `worker_pk`, receiver `r-<n>`, method_names `["submit_delivery"]`, allowance 0.05 NEAR.

### Change methods
| method | args | deposit | gas | caller | effect |
|---|---|---|---|---|---|
| `new` (init) | `{args: ClauseArgs}` | | | factory (parent account) only | |
| `ft_on_transfer` | NEP-141 `{sender_id, amount, msg}` | | | only the `asset` FT | returns U128 to refund: keeps up to the shortfall while `open` (exact deposit → `"0"`), refunds all otherwise |
| `sync_funding` | `{}` | 0 | 100 Tgas | anyone | reads `ft_balance_of`; `open` with balance ≥ amount → `funded`; in `released`/`returned`, sweeps balance to buyer |
| `ensure_registered` | `{}` | 0 | 30 Tgas | anyone | FT `storage_deposit` for itself, paid from the clause's own NEAR |
| `submit_delivery` | `{hash: string, note_hash?: string}` | **0** | **≥150 Tgas** (if challenge 0) | **predecessor must equal r-<n>**: the worker FC key, direct or delegated | `funded` and before deadline → `delivered`; `challenge_secs == 0` → pays the payee in the same call |
| `release` | `{}` | 0 | 150 Tgas | anyone | `delivered` and window passed → pays the payee |
| `expire` | `{}` | 0 | 150 Tgas | anyone | `open`/`funded` and `now ≥ deadline` → whole balance to buyer |
| `freeze` | `{}` | 0 | 30 Tgas | buyer | `delivered`, inside window, cosigner set → `frozen` |
| `cosign` | `{decision: "release" \| "return"}` | 0 | 150 Tgas | buyer or mandate cosigner | when both votes match, runs it; calling again retries a failed payout |
| `report_outcome` | `{}` | 0 | 30 Tgas | anyone | re-sends the terminal outcome to the factory (idempotent); sets `reported` when the factory accepts it |
| `close` | `{}` | 0 | 100 Tgas | anyone | `released`/`returned`, not settling, `reported` → FT `storage_unregister({force: false})` (fails while any token balance is left; run `sync_funding` first) → deletes the account, sending all its NEAR to `buyer`. Returns `false` if the unregister failed |
| `on_*` | callbacks | | | private | |

Panics: `NOT_REPORTED`, `ONLY_FACTORY`, `WRONG_ASSET`, `ONLY_WORKER_KEY`, `NOT_FUNDED`, `SETTLING`, `DEADLINE_PASSED`, `EMPTY_HASH`, `NOT_DELIVERED`, `CHALLENGE_WINDOW_OPEN`, `NOT_EXPIRABLE`, `NOT_EXPIRED`, `ONLY_BUYER`, `NO_COSIGNER`, `CHALLENGE_WINDOW_CLOSED`, `NOT_FROZEN`, `ONLY_BUYER_OR_COSIGNER`, `NOT_TERMINAL`.

Payout chain (release/expire/cosign/sweep): `storage_deposit(to)` → callback → `ft_transfer(to)` → callback that sets the state and calls `factory.record_outcome`. A failure emits `clause_settle_failed` and leaves the state unchanged, with `settling = false`, so it can be retried.

### Views
| method | returns |
|---|---|
| `get_state` | `"open" \| "funded" \| "delivered" \| "frozen" \| "released" \| "returned"` |
| `get_clause` | `ClauseView` |

```ts
ClauseView = { id: number, account_id: string, factory: string, buyer: string, payee: string,
  worker_pk: string, asset: string, amount: string, deadline: number, terms_hash: string,
  challenge_secs: number, cosigner: string | null, state: State, known_balance: string,
  delivered_at: number | null, delivery_hash: string | null, note_hash: string | null,
  buyer_vote: "release" | "return" | null, cosigner_vote: "release" | "return" | null,
  settling: boolean, paid: string, reported: boolean }
```
`known_balance` is the last balance seen by `ft_on_transfer`/`sync_funding`. For truth, read `ft_balance_of` on the FT.

## Relayer contract (NEP-366)

Yes: the relayer must accept exactly
`SignedDelegate { delegate_action: { sender_id: r-<n>, receiver_id: r-<n>, actions: [FunctionCall { method_name: "submit_delivery", args: {hash, note_hash?}, gas ≥ 150 Tgas, deposit: 0 }], public_key: <the clause's worker_pk>, nonce, max_block_height } }`.
Only one action. `sender_id == receiver_id == r-<n>.<factory>`, deposit 0. Anything else fails on chain anyway: the FC key restricts receiver and method, and NEAR rejects a non-zero deposit from an FC key. Validating it up front just saves the relayer's gas. The relayer's outer tx: `signer = relayer`, `receiver = r-<n>`, `actions = [Delegate]`. Suggested extra check: `public_key == get_clause().worker_pk` and `get_state() == "funded"`.

## Test stablecoin (testnet only): `musd.clausehold.testnet`

A NEP-141 + NEP-145 token, symbol `mUSD`, **6 decimals**. Deployed by `./deploy.sh testnet`. Never deployed on mainnet.

| method | args | deposit | gas | caller | returns |
|---|---|---|---|---|---|
| `faucet` | `{}` | **0** | 30 Tgas | **anyone** | U128 minted |
| `mint` | `{account_id, amount: U128}` | 0 | 30 Tgas | anyone (test helper; prefer `faucet` in UI) | — |
| `ft_transfer` / `ft_transfer_call` | NEP-141 | 1 yocto | 30 / 150 Tgas | holder | NEP-141 |
| `storage_deposit` | NEP-145 | 0.00125 NEAR | 30 Tgas | anyone | `{total, available}` |
| views | `ft_balance_of {account_id}`, `ft_metadata`, `ft_total_supply`, `storage_balance_of {account_id}`, `storage_balance_bounds` | | | | |

`faucet()` registers the caller if needed (the token pays the storage) and tops the caller's balance up to **100 mUSD (`"100000000"`)**. It returns how much it minted, which is `"0"` if the caller is already at the cap. The caller needs a NEAR account with a little NEAR for gas. Judges can create one with the testnet faucet and wallet.

## NEP-297 events

Format: `EVENT_JSON:{"standard":"clausehold","version":"1.0.0","event":"<name>","data":[{...}]}` (data is always a 1-element array).

Clause (emitted by `r-<n>`):
| event | data |
|---|---|
| `clause_open` | `{clause_id, account_id, amount}` |
| `clause_deposit` | `{clause_id, sender_id, kept: U128, refunded: U128}` |
| `clause_funded` | `{clause_id, amount, balance}` |
| `clause_delivered` | `{clause_id, hash, note_hash, challenge_secs}` |
| `clause_frozen` | `{clause_id, by}` |
| `clause_cosign` | `{clause_id, by, decision}` |
| `clause_released` | `{clause_id, payee, amount}` |
| `clause_returned` | `{clause_id, buyer, amount}` |
| `clause_swept` | `{clause_id, buyer, amount}` |
| `clause_settle_failed` | `{clause_id, payout: "release"\|"return"\|"sweep", step: "storage_deposit"\|"ft_transfer"\|"ft_balance_of", to?}` |
| `clause_sync_failed` | `{clause_id}` |

Factory:
| event | data |
|---|---|
| `mandate_set` | `{by, mandate: Mandate}` |
| `owner_set` | `{from, to}` |
| `clause_code_set` | `{len, sha256}` |
| `clause_created` | `{clause_id, account_id, buyer, payee, worker_pk, asset, amount, deadline, terms_hash, challenge_secs}` |
| `clause_failed` | `{clause_id, account_id}` |
| `clause_unregistered` | `{clause_id, account_id}` |
| `outcome_recorded` | `Receipt` |

Amounts in events are U128 strings. `clause_id` is a number.
