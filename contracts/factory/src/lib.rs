//! Clausehold factory (`clausehold.near` / `clausehold.testnet`).
//!
//! - Holds the mandate, set by the owner (a Sputnik DAO in production).
//! - `create_clause` enforces the mandate on chain, reserves the amount
//!   against the per-payee and daily caps, and creates `r-<n>.<factory>`
//!   running the clause wasm with exactly one access key: a function-call
//!   key for the worker, limited to `submit_delivery` on `r-<n>`.
//! - Clauses report back through `record_outcome`. A return gives the
//!   reservation back; a release keeps it counted.
//! - Every transition emits a NEP-297 `EVENT_JSON` log.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Allowance, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue, PublicKey,
};

pub const EVENT_STANDARD: &str = "clausehold";
pub const EVENT_VERSION: &str = "1.0.0";

/// Storage key that holds the clause wasm, written by `set_clause_code`.
pub const CODE_KEY: &[u8] = b"CODE";

/// NEP-145 registration deposit for the clause account on the FT.
pub const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Bytes on the clause account beyond the code: state, account record, key.
pub const CLAUSE_EXTRA_BYTES: u64 = 4_000;
/// Liquid NEAR left on the clause for its own storage_deposit calls.
pub const CLAUSE_OPS_BUFFER: NearToken = NearToken::from_millinear(100);
/// Gas allowance on the worker key, for direct (non-relayed) calls.
pub const WORKER_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(50);
/// Bytes the factory stores per clause (record, receipt, indexes).
pub const FACTORY_BYTES_PER_CLAUSE: u64 = 1_500;

const NS_PER_SEC: u64 = 1_000_000_000;
const NS_PER_DAY: u64 = 86_400 * NS_PER_SEC;

const GAS_CLAUSE_INIT: Gas = Gas::from_tgas(20);
const GAS_ON_CREATED: Gas = Gas::from_tgas(40);
const GAS_FT_STORAGE: Gas = Gas::from_tgas(10);
const GAS_ON_REGISTERED: Gas = Gas::from_tgas(10);

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
}

/// Mandate rules. Amounts are in the asset's base units. All allowed assets
/// are expected to share decimals (USDC-like stablecoins).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    pub allowed_assets: Vec<AccountId>,
    pub max_per_clause: U128,
    pub per_payee_daily_cap: U128,
    pub daily_cap: U128,
    /// Ceiling for a payee with no released clause yet.
    pub new_payee_ceiling: U128,
    pub paused: bool,
    /// Votes with the buyer on frozen clauses. No co-signer: no freeze.
    pub cosigner: Option<AccountId>,
    /// Accounts allowed to call `create_clause`. Empty means anyone.
    #[serde(default)]
    pub creators: Vec<AccountId>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Released,
    Returned,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ClauseStatus {
    /// Account creation in flight.
    Pending,
    Live,
    Released,
    Returned,
    /// Account creation failed; reservation given back, deposit refunded.
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ClauseRecord {
    pub id: u64,
    pub account_id: AccountId,
    pub buyer: AccountId,
    pub payee: AccountId,
    pub worker_pk: PublicKey,
    pub asset: AccountId,
    pub amount: U128,
    pub deadline: u64,
    pub terms_hash: String,
    pub challenge_secs: u64,
    pub created_by: AccountId,
    pub created_at: u64,
    /// Day index (unix days) the reservation was counted against.
    pub day: u64,
    pub status: ClauseStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub clause_id: u64,
    pub account_id: AccountId,
    pub buyer: AccountId,
    pub payee: AccountId,
    pub asset: AccountId,
    pub amount: U128,
    pub paid: U128,
    pub outcome: Outcome,
    pub terms_hash: String,
    /// Unix seconds.
    pub at: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RoleStats {
    pub open: u32,
    pub released: u32,
    pub returned: u32,
    /// Sum of released amounts.
    pub released_volume: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Standing {
    pub as_payee: RoleStats,
    pub as_buyer: RoleStats,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Usage {
    pub day: u64,
    pub daily_used: U128,
    pub payee_used: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct CodeInfo {
    pub len: u64,
    /// Hex sha256 of the clause wasm.
    pub sha256: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner: AccountId,
    mandate: Option<Mandate>,
    next_id: u64,
    clauses: LookupMap<u64, ClauseRecord>,
    daily_used: LookupMap<u64, u128>,
    payee_daily_used: LookupMap<(AccountId, u64), u128>,
    standings: LookupMap<AccountId, Standing>,
    receipts: Vector<Receipt>,
    receipts_by_account: LookupMap<AccountId, Vec<u32>>,
}

#[near]
#[derive(near_sdk::BorshStorageKey)]
enum Key {
    Clauses,
    Daily,
    PayeeDaily,
    Standings,
    Receipts,
    ReceiptsByAccount,
}

pub fn emit(event: &str, data: serde_json::Value) {
    log!(
        "EVENT_JSON:{}",
        json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
            "event": event,
            "data": [data],
        })
    );
}

fn mandate_fail(rule: &str) -> ! {
    env::panic_str(&format!("MANDATE:{rule}"))
}

/// Named accounts only. Implicit (64 hex), eth-implicit (0x...) and
/// deterministic (0s...) accounts are out of scope.
pub fn is_named(account: &AccountId) -> bool {
    let s = account.as_str();
    let hex64 = s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    !(hex64 || s.starts_with("0x") || s.starts_with("0s"))
}

fn day_of(ns: u64) -> u64 {
    ns / NS_PER_DAY
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner: AccountId, mandate: Option<Mandate>) -> Self {
        if let Some(m) = &mandate {
            validate_mandate(m);
        }
        Self {
            owner,
            mandate,
            next_id: 0,
            clauses: LookupMap::new(Key::Clauses),
            daily_used: LookupMap::new(Key::Daily),
            payee_daily_used: LookupMap::new(Key::PayeeDaily),
            standings: LookupMap::new(Key::Standings),
            receipts: Vector::new(Key::Receipts),
            receipts_by_account: LookupMap::new(Key::ReceiptsByAccount),
        }
    }

    // ---------------------------------------------------------------- owner

    pub fn set_mandate(&mut self, mandate: Mandate) {
        self.assert_owner();
        validate_mandate(&mandate);
        emit("mandate_set", json!({ "by": self.owner, "mandate": mandate }));
        self.mandate = Some(mandate);
    }

    /// Hand the factory to the DAO after setup.
    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        emit("owner_set", json!({ "from": self.owner, "to": owner }));
        self.owner = owner;
    }

    // ---------------------------------------------------------------- views

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_mandate(&self) -> Option<Mandate> {
        self.mandate.clone()
    }

    pub fn get_clause(&self, id: u64) -> Option<ClauseRecord> {
        self.clauses.get(&id).cloned()
    }

    pub fn get_clauses(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<ClauseRecord> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(200);
        (from..self.next_id)
            .filter_map(|id| self.clauses.get(&id).cloned())
            .take(limit as usize)
            .collect()
    }

    pub fn clause_count(&self) -> u64 {
        self.next_id
    }

    /// Outcome receipts where `account_id` is the buyer or the payee.
    /// With no account, all receipts.
    pub fn get_receipts(
        &self,
        account_id: Option<AccountId>,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Receipt> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(200) as usize;
        match account_id {
            Some(a) => self
                .receipts_by_account
                .get(&a)
                .map(|ids| {
                    ids.iter()
                        .skip(from)
                        .take(limit)
                        .filter_map(|i| self.receipts.get(*i).cloned())
                        .collect()
                })
                .unwrap_or_default(),
            None => self.receipts.iter().skip(from).take(limit).cloned().collect(),
        }
    }

    pub fn standing(&self, account_id: AccountId) -> Standing {
        self.standings.get(&account_id).cloned().unwrap_or_default()
    }

    /// Today's reserved totals, overall and for `payee`.
    pub fn usage(&self, payee: AccountId) -> Usage {
        let day = day_of(env::block_timestamp());
        Usage {
            day,
            daily_used: U128(self.daily_used.get(&day).copied().unwrap_or(0)),
            payee_used: U128(self.payee_daily_used.get(&(payee, day)).copied().unwrap_or(0)),
        }
    }

    pub fn clause_code_info(&self) -> Option<CodeInfo> {
        env::storage_read(CODE_KEY).map(|c| CodeInfo {
            len: c.len() as u64,
            sha256: to_hex(&env::sha256(&c)),
        })
    }

    /// NEAR to attach to `create_clause` with the current code.
    pub fn create_deposit(&self) -> U128 {
        let len = env::storage_read(CODE_KEY).map(|c| c.len() as u64).unwrap_or(0);
        U128(required_deposit(len).as_yoctonear())
    }

    // --------------------------------------------------------------- create

    /// Creates `r-<n>.<factory>` and returns its account id.
    /// Panics with `MANDATE:<rule>` when the mandate refuses it.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_clause(
        &mut self,
        buyer: AccountId,
        payee: AccountId,
        worker_pk: PublicKey,
        asset: AccountId,
        amount: U128,
        deadline: u64,
        terms_hash: String,
        challenge_secs: u64,
    ) -> Promise {
        let now = env::block_timestamp();
        let day = day_of(now);
        let creator = env::predecessor_account_id();
        let mandate = self.mandate.clone().unwrap_or_else(|| mandate_fail("not_set"));

        // Shape checks.
        require!(amount.0 > 0, "AMOUNT_ZERO");
        require!(is_named(&payee), "PAYEE_NOT_NAMED");
        require!(deadline.saturating_mul(NS_PER_SEC) > now, "DEADLINE_IN_PAST");
        require!(!terms_hash.is_empty(), "EMPTY_TERMS_HASH");
        require!(
            worker_pk.curve_type() == near_sdk::CurveType::ED25519,
            "WORKER_PK_NOT_ED25519"
        );

        // Mandate. The rule name is the panic message.
        self.check_mandate(&mandate, &creator, &payee, &asset, amount.0, day);

        let code = env::storage_read(CODE_KEY).unwrap_or_else(|| env::panic_str("NO_CLAUSE_CODE"));
        let need = required_deposit(code.len() as u64);
        let attached = env::attached_deposit();
        require!(
            attached >= need,
            format!("DEPOSIT_TOO_LOW: attach {} yoctoNEAR", need.as_yoctonear())
        );

        // Reserve against today's caps now, so a second create in the same
        // block already sees it.
        *self.daily_used.entry(day).or_insert(0) += amount.0;
        *self.payee_daily_used.entry((payee.clone(), day)).or_insert(0) += amount.0;

        let id = self.next_id;
        self.next_id += 1;
        let account_id: AccountId = format!("r-{id}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("BAD_SUBACCOUNT"));

        self.clauses.insert(
            id,
            ClauseRecord {
                id,
                account_id: account_id.clone(),
                buyer: buyer.clone(),
                payee: payee.clone(),
                worker_pk: worker_pk.clone(),
                asset: asset.clone(),
                amount,
                deadline,
                terms_hash: terms_hash.clone(),
                challenge_secs,
                created_by: creator.clone(),
                created_at: now / NS_PER_SEC,
                day,
                status: ClauseStatus::Pending,
            },
        );

        let excess = attached.saturating_sub(need);
        if !excess.is_zero() {
            Promise::new(creator.clone()).transfer(excess).detach();
        }

        let init = json!({
            "args": {
                "id": id,
                "buyer": buyer,
                "payee": payee,
                "worker_pk": worker_pk,
                "asset": asset,
                "amount": amount,
                "deadline": deadline,
                "terms_hash": terms_hash,
                "challenge_secs": challenge_secs,
                "cosigner": mandate.cosigner,
            }
        });
        let funding = clause_funding(code.len() as u64);
        let allowance = Allowance::limited(WORKER_KEY_ALLOWANCE)
            .unwrap_or_else(|| env::panic_str("BAD_ALLOWANCE"));

        Promise::new(account_id.clone())
            .create_account()
            .transfer(funding)
            .deploy_contract(code)
            .function_call(
                "new",
                serde_json::to_vec(&init).unwrap(),
                NearToken::from_yoctonear(0),
                GAS_CLAUSE_INIT,
            )
            // The one and only key. No full-access key is ever added.
            .add_access_key_allowance(worker_pk, allowance, account_id, "submit_delivery")
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_CREATED)
                    .on_clause_created(id, creator, U128(funding.saturating_add(FT_STORAGE_DEPOSIT).as_yoctonear())),
            )
    }

    #[private]
    pub fn on_clause_created(
        &mut self,
        id: u64,
        creator: AccountId,
        refund: U128,
    ) -> PromiseOrValue<Option<AccountId>> {
        let mut rec = self.clauses.get(&id).cloned().unwrap_or_else(|| env::panic_str("NO_CLAUSE"));
        if !previous_ok() {
            // No panic here: a panic would revert the refund and the unreserve.
            self.unreserve(&rec);
            rec.status = ClauseStatus::Failed;
            self.clauses.insert(id, rec.clone());
            emit(
                "clause_failed",
                json!({ "clause_id": id, "account_id": rec.account_id }),
            );
            Promise::new(creator).transfer(NearToken::from_yoctonear(refund.0)).detach();
            return PromiseOrValue::Value(None);
        }
        rec.status = ClauseStatus::Live;
        self.clauses.insert(id, rec.clone());
        self.standing_mut(&rec.payee).as_payee.open += 1;
        self.standing_mut(&rec.buyer).as_buyer.open += 1;
        emit(
            "clause_created",
            json!({
                "clause_id": id,
                "account_id": rec.account_id,
                "buyer": rec.buyer,
                "payee": rec.payee,
                "worker_pk": rec.worker_pk,
                "asset": rec.asset,
                "amount": rec.amount,
                "deadline": rec.deadline,
                "terms_hash": rec.terms_hash,
                "challenge_secs": rec.challenge_secs,
            }),
        );
        PromiseOrValue::Promise(
            ext_ft::ext(rec.asset.clone())
                .with_static_gas(GAS_FT_STORAGE)
                .with_attached_deposit(FT_STORAGE_DEPOSIT)
                .storage_deposit(Some(rec.account_id.clone()), Some(true))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_REGISTERED)
                        .on_clause_registered(id, rec.account_id),
                ),
        )
    }

    /// Returns the clause account id either way. A failed registration is
    /// logged; anyone can fix it with `ensure_registered` on the clause.
    #[private]
    pub fn on_clause_registered(&mut self, id: u64, account_id: AccountId) -> Option<AccountId> {
        if !previous_ok() {
            emit(
                "clause_unregistered",
                json!({ "clause_id": id, "account_id": account_id }),
            );
        }
        Some(account_id)
    }

    // -------------------------------------------------------------- outcome

    /// Only the clause account itself may report. Duplicates are ignored.
    pub fn record_outcome(&mut self, id: u64, outcome: Outcome, paid: U128) -> bool {
        let mut rec = self.clauses.get(&id).cloned().unwrap_or_else(|| env::panic_str("NO_CLAUSE"));
        require!(env::predecessor_account_id() == rec.account_id, "ONLY_OWN_CLAUSE");
        if rec.status != ClauseStatus::Live {
            return false;
        }
        rec.status = match outcome {
            Outcome::Released => ClauseStatus::Released,
            Outcome::Returned => ClauseStatus::Returned,
        };
        self.clauses.insert(id, rec.clone());

        {
            let p = &mut self.standing_mut(&rec.payee).as_payee;
            p.open = p.open.saturating_sub(1);
            match outcome {
                Outcome::Released => {
                    p.released += 1;
                    p.released_volume = U128(p.released_volume.0 + paid.0);
                }
                Outcome::Returned => p.returned += 1,
            }
        }
        {
            let b = &mut self.standing_mut(&rec.buyer).as_buyer;
            b.open = b.open.saturating_sub(1);
            match outcome {
                Outcome::Released => {
                    b.released += 1;
                    b.released_volume = U128(b.released_volume.0 + paid.0);
                }
                Outcome::Returned => b.returned += 1,
            }
        }
        if outcome == Outcome::Returned {
            self.unreserve(&rec);
        }

        let receipt = Receipt {
            clause_id: id,
            account_id: rec.account_id.clone(),
            buyer: rec.buyer.clone(),
            payee: rec.payee.clone(),
            asset: rec.asset.clone(),
            amount: rec.amount,
            paid,
            outcome,
            terms_hash: rec.terms_hash.clone(),
            at: env::block_timestamp() / NS_PER_SEC,
        };
        let idx = self.receipts.len();
        self.receipts.push(receipt.clone());
        self.receipts_by_account
            .entry(rec.buyer.clone())
            .or_default()
            .push(idx);
        if rec.payee != rec.buyer {
            self.receipts_by_account
                .entry(rec.payee.clone())
                .or_default()
                .push(idx);
        }
        emit("outcome_recorded", serde_json::to_value(&receipt).unwrap());
        true
    }
}

impl Factory {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ONLY_OWNER");
    }

    fn standing_mut(&mut self, account: &AccountId) -> &mut Standing {
        self.standings.entry(account.clone()).or_default()
    }

    fn check_mandate(
        &self,
        m: &Mandate,
        creator: &AccountId,
        payee: &AccountId,
        asset: &AccountId,
        amount: u128,
        day: u64,
    ) {
        if m.paused {
            mandate_fail("paused");
        }
        if !m.creators.is_empty() && !m.creators.contains(creator) {
            mandate_fail("creators");
        }
        if !m.allowed_assets.contains(asset) {
            mandate_fail("allowed_assets");
        }
        if amount > m.max_per_clause.0 {
            mandate_fail("max_per_clause");
        }
        let released_before = self
            .standings
            .get(payee)
            .map(|s| s.as_payee.released)
            .unwrap_or(0);
        if released_before == 0 && amount > m.new_payee_ceiling.0 {
            mandate_fail("new_payee_ceiling");
        }
        let payee_used = self
            .payee_daily_used
            .get(&(payee.clone(), day))
            .copied()
            .unwrap_or(0);
        if payee_used.saturating_add(amount) > m.per_payee_daily_cap.0 {
            mandate_fail("per_payee_daily_cap");
        }
        let used = self.daily_used.get(&day).copied().unwrap_or(0);
        if used.saturating_add(amount) > m.daily_cap.0 {
            mandate_fail("daily_cap");
        }
    }

    fn unreserve(&mut self, rec: &ClauseRecord) {
        if let Some(v) = self.daily_used.get_mut(&rec.day) {
            *v = v.saturating_sub(rec.amount.0);
        }
        if let Some(v) = self.payee_daily_used.get_mut(&(rec.payee.clone(), rec.day)) {
            *v = v.saturating_sub(rec.amount.0);
        }
    }

    /// Owner-only: store the clause wasm. Exposed as the raw-input method
    /// `set_clause_code` (the call's arguments are the wasm bytes).
    pub fn store_clause_code(&self, code: &[u8]) {
        self.assert_owner();
        require!(code.len() > 4 && &code[..4] == b"\0asm", "NOT_WASM");
        env::storage_write(CODE_KEY, code);
        emit(
            "clause_code_set",
            json!({ "len": code.len(), "sha256": to_hex(&env::sha256(code)) }),
        );
    }
}

fn validate_mandate(m: &Mandate) {
    require!(!m.allowed_assets.is_empty(), "MANDATE_NO_ASSETS");
    require!(m.max_per_clause.0 > 0, "MANDATE_ZERO_MAX");
    require!(
        m.max_per_clause.0 <= m.daily_cap.0,
        "MANDATE_MAX_ABOVE_DAILY"
    );
}

/// NEAR sent to the new clause account.
pub fn clause_funding(code_len: u64) -> NearToken {
    env::storage_byte_cost()
        .saturating_mul((code_len + CLAUSE_EXTRA_BYTES) as u128)
        .saturating_add(CLAUSE_OPS_BUFFER)
}

/// Total NEAR `create_clause` needs attached.
pub fn required_deposit(code_len: u64) -> NearToken {
    clause_funding(code_len)
        .saturating_add(FT_STORAGE_DEPOSIT)
        .saturating_add(env::storage_byte_cost().saturating_mul(FACTORY_BYTES_PER_CLAUSE as u128))
}

fn previous_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok()
}

/// Raw-input method: the transaction's argument bytes are the clause wasm.
/// `near contract call-function as-transaction clausehold.testnet
///   set_clause_code file-args target/near/clause/clause.wasm ...`
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn set_clause_code() {
    env::setup_panic_hook();
    let contract: Factory = env::state_read().unwrap_or_else(|| env::panic_str("NOT_INIT"));
    let code = env::input().unwrap_or_else(|| env::panic_str("NO_INPUT"));
    contract.store_clause_code(&code);
}

#[cfg(test)]
mod tests;
