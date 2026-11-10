# Clausehold contracts

Rust, near-sdk 5.30. One cargo workspace:

| crate | what it is |
|---|---|
| `factory` | `clausehold.near` / `clausehold.testnet`. Holds the mandate, creates clauses, keeps receipts and standing. |
| `clause` | One escrow per job at `r-<n>.<factory>`. Deployed by the factory, never by hand. |
| `mock-ft` | Test-only NEP-141 (`mUSD`, 6 decimals) with a public `faucet()` (100 mUSD per account), open `mint` and failure switches. Testnet demo token. Never on mainnet. |
| `sandbox-tests` | near-workspaces tests that run all three in a local sandbox. |

## How the money moves

1. `factory.create_clause(buyer, payee, worker_pk, asset, amount, deadline, terms_hash, challenge_secs)`
   - checks the mandate on chain and panics with `MANDATE:<rule>` (`paused`, `creators`, `allowed_assets`, `max_per_clause`, `new_payee_ceiling`, `per_payee_daily_cap`, `daily_cap`, `not_set`)
   - **reserves** `amount` against today's per-payee and daily caps; a return gives it back, a release keeps it counted
   - creates `r-<n>`, deploys the clause wasm stored in the factory, and adds **one** access key: a function-call key for `worker_pk`, receiver `r-<n>`, method `submit_delivery`. There is no full-access key
   - calls `storage_deposit` on the FT for `r-<n>`, then returns `"r-<n>.<factory>"` (or `null` if account creation failed, in which case the deposit is refunded)
   - attach `create_deposit()` yoctoNEAR (≈ code size × storage price + 0.1 NEAR); any excess is refunded
2. Funding: either `ft_transfer_call` (the clause's `ft_on_transfer` returns `0` and keeps the tokens while Open) or a plain `ft_transfer` (how a 1Click delivery lands) followed by `sync_funding()`, which anyone may call.
3. `submit_delivery(hash, note_hash?)` checks only `predecessor == current_account_id`. That is true only when the transaction comes from the worker's FC key, either directly or as a NEP-366 delegate relayed by anyone. The contract never reads `signer_account_pk`. With `challenge_secs == 0` it pays the payee in the same call.
4. `release()` (anyone, after the window) and `expire()` (anyone, after the deadline, if not delivered) run `storage_deposit` → callback → `ft_transfer` → callback. The state changes only in the last callback, which also calls `factory.record_outcome`. A failure anywhere unlocks the clause and leaves it retryable.
5. `freeze()` (buyer, inside the window) then `cosign(decision)` from both the buyer and the mandate co-signer. Matching votes run the decision; calling `cosign` again retries a failed payout.
6. In `Released` or `Returned`, `sync_funding()` sweeps any balance (late or excess deposits) to the buyer.
7. Once settled and recorded by the factory, `close()` (anyone) unregisters the clause from the token, which fails while any balance is left, then deletes the account and sends its NEAR (the storage deposit, about 1.95 NEAR) to the buyer. The factory keeps the clause's record and receipt.

There is no withdraw method. Tokens leave a clause only to the payee (release), to the buyer (return or sweep), or back to the sender (`ft_on_transfer` refund).

Events: every transition logs NEP-297 `EVENT_JSON` with `standard: "clausehold"`, `version: "1.0.0"`:
`clause_open`, `clause_deposit`, `clause_funded`, `clause_delivered`, `clause_frozen`, `clause_cosign`, `clause_released`, `clause_returned`, `clause_swept`, `clause_settle_failed`, `clause_sync_failed` (clause) and `mandate_set`, `owner_set`, `clause_code_set`, `clause_created`, `clause_failed`, `clause_unregistered`, `outcome_recorded` (factory).

Factory views: `get_mandate`, `get_receipts({account_id?, from_index?, limit?})`, `standing({account_id})`, `usage({payee})`, `get_clause({id})`, `get_clauses`, `clause_count`, `clause_code_info`, `create_deposit`, `get_owner`.
Clause views: `get_clause`, `get_state`.

## Build

The wasm builds on Linux, macOS or WSL. The sandbox tests need Linux or macOS (on Windows, run everything inside WSL).

```bash
cargo install cargo-near --locked
```

```bash
cd contracts && ./build.sh
```

`build.sh` runs `cargo near build non-reproducible-wasm` for `clause`, `factory` and `mock-ft` and leaves the files at `target/near/<crate>/<crate>.wasm` (or under `$CARGO_TARGET_DIR/near/` if that is set).

Without cargo-near (for example on Windows, where it needs OpenSSL to install), `build.sh` runs the same two steps itself: `cargo build --target wasm32-unknown-unknown --release` with `-C link-arg=-s --cfg near`, then `wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int`. That needs `rustup target add wasm32-unknown-unknown` and binaryen's `wasm-opt`. Rust 1.87+ emits bulk-memory opcodes, which nearcore 2.12+ (protocol 84) accepts on testnet and mainnet.

## Test

```bash
cd contracts && cargo test -p clause -p factory
```

```bash
cd contracts && ./build.sh && cargo test -p sandbox-tests -- --test-threads=2
```

The unit tests cover every guard and callback. The sandbox tests start a local `neard` (downloaded on first run), deploy all three contracts, and check:
- `r-<n>` has exactly one key: FC, receiver `r-<n>`, method `submit_delivery`
- a delegate signed by the worker key and relayed by a third account **succeeds** and releases in the same call
- a direct `submit_delivery` from any other account fails with `ONLY_WORKER_KEY`
- the worker key cannot call any other method, any other contract, or move NEAR, directly or by delegate
- no withdraw path after delivery; forged callbacks fail
- over-mandate `create_clause` panics with the rule name; the reservation blocks clause N+1
- `expire` before the deadline fails; after it, the buyer is refunded and the reservation freed
- a late deposit after `Returned` is swept to the buyer
- `ft_on_transfer` returns 0 when funding (all tokens kept)
- a failed `ft_transfer` leaves the clause retryable, and the retry releases
- freeze, then cosign from both parties

Set `CLAUSEHOLD_WASM_DIR` if the wasm lives somewhere other than `target/near`.

### Same tests on NEAR testnet (no funds, no Linux)

```bash
cd contracts && CLAUSEHOLD_NETWORK=testnet cargo test -p sandbox-tests --no-default-features -- --test-threads=1
```

This runs the same suite against the public testnet. Each test creates three faucet-funded dev accounts, deploys fresh copies of the factory, clause and test FT, and runs the flow on chain, including the relayed NEP-366 delivery. Deadline and challenge-window tests wait in real time instead of fast-forwarding, so a full run takes several minutes. `--no-default-features` skips the build-time download of the local `neard` sandbox binary, which has no Windows build. The default `cargo test` still downloads it and runs the local sandbox suite. On Windows, add `AWS_LC_SYS_PREBUILT_NASM=1` if NASM is not installed.

## Networks

Both networks run the same wasm. Testnet is live; the mainnet factory is not deployed yet.

| | testnet | mainnet |
|---|---|---|
| factory | `clausehold.testnet` | `clausehold.near` |
| asset | `musd.clausehold.testnet` (mock FT, anyone can mint) | native USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| funding | `ft_transfer_call`, or `ft_transfer` + `sync_funding` | NEAR Intents 1Click, then `sync_funding` |
| cost | free (faucet NEAR) | real NEAR for storage, plus a little USDC |

Testnet is the path for judges and anyone without funds. One script deploys either:

```bash
cd contracts && ./build.sh && ./deploy.sh testnet
```

```bash
cd contracts && CONFIRM=mainnet ./deploy.sh mainnet
```

`deploy.sh` deploys the factory, uploads the clause wasm, deploys the test FT (testnet only) and sets the mandate. Set `DAO=<sputnik dao account>` to hand ownership to the DAO at the end. The step-by-step commands below do the same by hand.

## Deploy to testnet by hand

These commands use [near-cli-rs](https://github.com/near/near-cli-rs) (`near`). `$ME` is your testnet account, which signs the setup.

```bash
export ME=you.testnet F=clausehold.testnet
```

1. Create the factory account (faucet-funded) and deploy:

```bash
near account create-account sponsor-by-faucet-service $F autogenerate-new-keypair save-to-keychain network-config testnet create
```

```bash
near contract deploy $F use-file target/near/factory/factory.wasm with-init-call new json-args "{\"owner\":\"$F\",\"mandate\":null}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

2. Upload the clause wasm. The raw file is the call's argument:

```bash
near contract call-function as-transaction $F set_clause_code file-args target/near/clause/clause.wasm prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as $F network-config testnet sign-with-keychain send
```

3. Deploy the test token and give the buyer some:

```bash
near account create-account fund-myself musd.$F '3 NEAR' autogenerate-new-keypair save-to-keychain sign-as $F network-config testnet sign-with-keychain send
```

```bash
near contract deploy musd.$F use-file target/near/mock_ft/mock_ft.wasm with-init-call new json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

```bash
near contract call-function as-transaction musd.$F mint json-args "{\"account_id\":\"$ME\",\"amount\":\"100000000\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $ME network-config testnet sign-with-keychain send
```

4. Set the mandate (2 USDC = `2000000`; the co-signer votes on frozen clauses):

```bash
near contract call-function as-transaction $F set_mandate json-args "{\"mandate\":{\"allowed_assets\":[\"musd.$F\"],\"max_per_clause\":\"5000000\",\"per_payee_daily_cap\":\"10000000\",\"daily_cap\":\"50000000\",\"new_payee_ceiling\":\"3000000\",\"paused\":false,\"cosigner\":\"$ME\",\"creators\":[]}}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $F network-config testnet sign-with-keychain send
```

5. Hand the factory to the DAO once it exists (after this, only DAO proposals can change the mandate):

```bash
near contract call-function as-transaction $F set_owner json-args '{"owner":"clausehold.sputnikv2.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as $F network-config testnet sign-with-keychain send
```

6. Open a clause. Read the deposit first, then attach it:

```bash
near contract call-function as-read-only $F create_deposit json-args '{}' network-config testnet now
```

```bash
near contract call-function as-transaction $F create_clause json-args "{\"buyer\":\"$ME\",\"payee\":\"payee.testnet\",\"worker_pk\":\"ed25519:...\",\"asset\":\"musd.$F\",\"amount\":\"2000000\",\"deadline\":$(( $(date +%s) + 900 )),\"terms_hash\":\"sha256:...\",\"challenge_secs\":0}" prepaid-gas '300 Tgas' attached-deposit '<create_deposit> yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send
```

7. Fund it (`r-0.$F`), then check it:

```bash
near contract call-function as-transaction musd.$F ft_transfer_call json-args "{\"receiver_id\":\"r-0.$F\",\"amount\":\"2000000\",\"msg\":\"\"}" prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as $ME network-config testnet sign-with-keychain send
```

```bash
near contract call-function as-read-only r-0.$F get_clause json-args '{}' network-config testnet now
```

Delivery comes from the worker page as a NEP-366 delegate (see `src/near/relayer.ts`). Attach at least 150 Tgas to the inner `submit_delivery` call so the same-call release has room.

On mainnet the factory is `clausehold.near`, the asset is native USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`), and funding arrives through NEAR Intents 1Click as a plain `ft_transfer`, so the desk calls `sync_funding` after 1Click reports SUCCESS.

## Known limits

- Caps are in base units of the asset and assume every allowed asset has the same decimals.
- `payee` must be a named account. The contract rejects implicit-looking ids, but it cannot check on chain that the account exists.
- A frozen clause whose buyer and co-signer never agree stays frozen. There is no timeout.
- Global contracts (NEP-591) are not used. Each clause pays storage for its own copy of the code (about the code size × 10¹⁹ yoctoNEAR per byte).
