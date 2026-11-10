//! Clausehold clause: one escrow per job, living at `r-<n>.<factory>`.
//!
//! The account has no full-access key. Its only access key is a function-call
//! key for the worker, limited to `submit_delivery` on this account. That key
//! is the only way to mark a job delivered. NEP-366 meta-transactions let a
//! relayer pay the gas: the relayer is the signer, and the predecessor is this
//! account. So the only check is `predecessor == current_account_id`. The
//! signer's key is never read.
//!
//! State machine:
//! `Open -> Funded -> Delivered -> Released | Returned`, and
//! `Delivered -> Frozen -> (cosign) Released | Returned`.
//! There is no withdraw method. Tokens leave only to the payee (release), to
//! the buyer (return or sweep), or back to the sender (ft_on_transfer refund).
//! After settling, `close` deletes the account and its NEAR goes to the buyer.
//! It first leaves the token with `storage_unregister(force: false)`, which
//! fails while any token balance is left, so no tokens can be stranded.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue, PublicKey,
};

pub const EVENT_STANDARD: &str = "clausehold";
pub const EVENT_VERSION: &str = "1.0.0";

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEP-145 registration deposit. Real USDC on NEAR asks for 0.00125 NEAR.
/// With `registration_only = true` any excess is refunded.
pub const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);

const GAS_FT_BALANCE: Gas = Gas::from_tgas(5);
const GAS_FT_STORAGE: Gas = Gas::from_tgas(10);
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_RECORD_OUTCOME: Gas = Gas::from_tgas(15);
const GAS_ON_TRANSFERRED: Gas = Gas::from_tgas(30);
const GAS_ON_REGISTERED: Gas = Gas::from_tgas(55);
const GAS_ON_BALANCE: Gas = Gas::from_tgas(75);
const GAS_ON_REPORTED: Gas = Gas::from_tgas(5);
const GAS_ON_UNREGISTERED: Gas = Gas::from_tgas(10);

const NS_PER_SEC: u64 = 1_000_000_000;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn storage_unregister(&mut self, force: Option<bool>) -> bool;
}

#[ext_contract(ext_factory)]
#[allow(dead_code)]
trait Factory {
    fn record_outcome(&mut self, id: u64, outcome: Outcome, paid: U128);
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Open,
    Funded,
    Delivered,
    Frozen,
    Released,
    Returned,
}

impl State {
    pub fn is_terminal(self) -> bool {
        matches!(self, State::Released | State::Returned)
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Release,
    Return,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Released,
    Returned,
}

/// Why tokens are leaving the clause.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Payout {
    Release,
    Return,
    Sweep,
}

/// Init arguments. The factory passes these when it deploys the clause.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClauseArgs {
    pub id: u64,
    pub buyer: AccountId,
    pub payee: AccountId,
    pub worker_pk: PublicKey,
    pub asset: AccountId,
    pub amount: U128,
    /// Unix seconds.
    pub deadline: u64,
    pub terms_hash: String,
    pub challenge_secs: u64,
    pub cosigner: Option<AccountId>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClauseView {
    pub id: u64,
    pub account_id: AccountId,
    pub factory: AccountId,
    pub buyer: AccountId,
    pub payee: AccountId,
    pub worker_pk: PublicKey,
    pub asset: AccountId,
    pub amount: U128,
    pub deadline: u64,
    pub terms_hash: String,
    pub challenge_secs: u64,
    pub cosigner: Option<AccountId>,
    pub state: State,
    pub known_balance: U128,
    pub delivered_at: Option<u64>,
    pub delivery_hash: Option<String>,
    pub note_hash: Option<String>,
    pub buyer_vote: Option<Decision>,
    pub cosigner_vote: Option<Decision>,
    pub settling: bool,
    pub paid: U128,
    /// The factory has recorded the outcome, so the clause may be closed.
    pub reported: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Clause {
    factory: AccountId,
    id: u64,
    buyer: AccountId,
    payee: AccountId,
    worker_pk: PublicKey,
    asset: AccountId,
    amount: u128,
    deadline_ns: u64,
    terms_hash: String,
    challenge_ns: u64,
    cosigner: Option<AccountId>,
    state: State,
    /// Last balance seen through `ft_on_transfer` or `sync_funding`.
    known_balance: u128,
    delivered_at_ns: Option<u64>,
    delivery_hash: Option<String>,
    note_hash: Option<String>,
    buyer_vote: Option<Decision>,
    cosigner_vote: Option<Decision>,
    /// A payout chain is in flight. Blocks a second concurrent payout.
    settling: bool,
    /// Amount sent out by the terminal payout (release or return).
    paid: u128,
    /// Set once the factory has recorded the outcome. `close` waits for it,
    /// so standing is never lost when the account goes away.
    reported: bool,
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

fn now_ns() -> u64 {
    env::block_timestamp()
}

/// True when the single promise this callback waits on succeeded.
fn previous_ok() -> bool {
    env::promise_results_count() == 1 && env::promise_result_checked(0, 1024).is_ok()
}

#[near]
impl Clause {
    #[init]
    pub fn new(args: ClauseArgs) -> Self {
        let me = env::current_account_id();
        let parent = me
            .as_str()
            .split_once('.')
            .map(|(_, p)| p.to_string())
            .unwrap_or_default();
        let factory = env::predecessor_account_id();
        require!(factory.as_str() == parent, "ONLY_FACTORY");
        require!(args.amount.0 > 0, "AMOUNT_ZERO");
        let clause = Self {
            factory,
            id: args.id,
            buyer: args.buyer,
            payee: args.payee,
            worker_pk: args.worker_pk,
            asset: args.asset,
            amount: args.amount.0,
            deadline_ns: args.deadline.saturating_mul(NS_PER_SEC),
            terms_hash: args.terms_hash,
            challenge_ns: args.challenge_secs.saturating_mul(NS_PER_SEC),
            cosigner: args.cosigner,
            state: State::Open,
            known_balance: 0,
            delivered_at_ns: None,
            delivery_hash: None,
            note_hash: None,
            buyer_vote: None,
            cosigner_vote: None,
            settling: false,
            paid: 0,
            reported: false,
        };
        emit(
            "clause_open",
            json!({ "clause_id": clause.id, "account_id": me, "amount": U128(clause.amount) }),
        );
        clause
    }

    // ---------------------------------------------------------------- views

    pub fn get_clause(&self) -> ClauseView {
        ClauseView {
            id: self.id,
            account_id: env::current_account_id(),
            factory: self.factory.clone(),
            buyer: self.buyer.clone(),
            payee: self.payee.clone(),
            worker_pk: self.worker_pk.clone(),
            asset: self.asset.clone(),
            amount: U128(self.amount),
            deadline: self.deadline_ns / NS_PER_SEC,
            terms_hash: self.terms_hash.clone(),
            challenge_secs: self.challenge_ns / NS_PER_SEC,
            cosigner: self.cosigner.clone(),
            state: self.state,
            known_balance: U128(self.known_balance),
            delivered_at: self.delivered_at_ns.map(|t| t / NS_PER_SEC),
            delivery_hash: self.delivery_hash.clone(),
            note_hash: self.note_hash.clone(),
            buyer_vote: self.buyer_vote,
            cosigner_vote: self.cosigner_vote,
            settling: self.settling,
            paid: U128(self.paid),
            reported: self.reported,
        }
    }

    pub fn get_state(&self) -> State {
        self.state
    }

    // -------------------------------------------------------------- funding

    /// NEP-141 receiver. Returns the amount to refund to the sender.
    /// While Open it keeps up to the shortfall (so a full deposit returns 0).
    /// In any other state it refunds the whole amount.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        require!(env::predecessor_account_id() == self.asset, "WRONG_ASSET");
        if self.state != State::Open || self.settling {
            return PromiseOrValue::Value(amount);
        }
        let needed = self.amount.saturating_sub(self.known_balance);
        let keep = amount.0.min(needed);
        self.known_balance += keep;
        emit(
            "clause_deposit",
            json!({ "clause_id": self.id, "sender_id": sender_id, "kept": U128(keep), "refunded": U128(amount.0 - keep) }),
        );
        if self.known_balance >= self.amount {
            self.mark_funded();
        }
        PromiseOrValue::Value(U128(amount.0 - keep))
    }

    /// Anyone may call. Reads this account's FT balance. Open with enough
    /// balance becomes Funded. In a terminal state, any balance (late or
    /// excess deposits) is swept to the buyer.
    pub fn sync_funding(&mut self) -> Promise {
        ext_ft::ext(self.asset.clone())
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_BALANCE)
                    .on_sync_balance(),
            )
    }

    #[private]
    pub fn on_sync_balance(
        &mut self,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(U128(bal)) = balance else {
            emit("clause_sync_failed", json!({ "clause_id": self.id }));
            return PromiseOrValue::Value(false);
        };
        self.known_balance = bal;
        match self.state {
            State::Open if bal >= self.amount => {
                self.mark_funded();
                PromiseOrValue::Value(true)
            }
            s if s.is_terminal() && bal > 0 && !self.settling => {
                PromiseOrValue::Promise(self.begin_payout(Payout::Sweep, self.buyer.clone(), bal))
            }
            _ => PromiseOrValue::Value(true),
        }
    }

    /// Anyone may call. Registers this account with the FT (NEP-145) from
    /// the clause's own NEAR, in case the factory's registration failed.
    pub fn ensure_registered(&mut self) -> Promise {
        ext_ft::ext(self.asset.clone())
            .with_static_gas(GAS_FT_STORAGE)
            .with_attached_deposit(FT_STORAGE_DEPOSIT)
            .storage_deposit(Some(env::current_account_id()), Some(true))
    }

    // ------------------------------------------------------------- delivery

    /// Only callable by this account itself, which in practice means the
    /// worker's function-call key, usually inside a NEP-366 delegate action
    /// relayed by someone else. Never reads `signer_account_pk`.
    pub fn submit_delivery(&mut self, hash: String, note_hash: Option<String>) -> PromiseOrValue<bool> {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "ONLY_WORKER_KEY"
        );
        require!(self.state == State::Funded, "NOT_FUNDED");
        require!(!self.settling, "SETTLING");
        require!(now_ns() < self.deadline_ns, "DEADLINE_PASSED");
        require!(!hash.is_empty(), "EMPTY_HASH");
        self.state = State::Delivered;
        self.delivered_at_ns = Some(now_ns());
        self.delivery_hash = Some(hash.clone());
        self.note_hash = note_hash.clone();
        emit(
            "clause_delivered",
            json!({ "clause_id": self.id, "hash": hash, "note_hash": note_hash, "challenge_secs": self.challenge_ns / NS_PER_SEC }),
        );
        if self.challenge_ns == 0 {
            PromiseOrValue::Promise(self.begin_payout(Payout::Release, self.payee.clone(), self.amount))
        } else {
            PromiseOrValue::Value(true)
        }
    }

    // --------------------------------------------------------------- settle

    /// Anyone may call once the challenge window has passed.
    pub fn release(&mut self) -> Promise {
        require!(self.state == State::Delivered, "NOT_DELIVERED");
        require!(!self.settling, "SETTLING");
        let delivered = self.delivered_at_ns.unwrap_or(0);
        require!(
            now_ns() >= delivered.saturating_add(self.challenge_ns),
            "CHALLENGE_WINDOW_OPEN"
        );
        self.begin_payout(Payout::Release, self.payee.clone(), self.amount)
    }

    /// Anyone may call after the deadline if the work was not delivered.
    /// Returns the whole balance to the buyer.
    pub fn expire(&mut self) -> Promise {
        require!(
            matches!(self.state, State::Open | State::Funded),
            "NOT_EXPIRABLE"
        );
        require!(!self.settling, "SETTLING");
        require!(now_ns() >= self.deadline_ns, "NOT_EXPIRED");
        self.begin_return()
    }

    /// Buyer only, inside the challenge window. Needs a mandate co-signer.
    pub fn freeze(&mut self) {
        require!(env::predecessor_account_id() == self.buyer, "ONLY_BUYER");
        require!(self.state == State::Delivered, "NOT_DELIVERED");
        require!(!self.settling, "SETTLING");
        require!(self.cosigner.is_some(), "NO_COSIGNER");
        let delivered = self.delivered_at_ns.unwrap_or(0);
        require!(
            now_ns() < delivered.saturating_add(self.challenge_ns),
            "CHALLENGE_WINDOW_CLOSED"
        );
        self.state = State::Frozen;
        emit("clause_frozen", json!({ "clause_id": self.id, "by": self.buyer }));
    }

    /// Buyer and mandate co-signer each vote. When both votes match, the
    /// decision runs. Calling again after a failed payout retries it.
    pub fn cosign(&mut self, decision: Decision) -> PromiseOrValue<bool> {
        require!(self.state == State::Frozen, "NOT_FROZEN");
        require!(!self.settling, "SETTLING");
        let who = env::predecessor_account_id();
        let is_buyer = who == self.buyer;
        let is_cosigner = self.cosigner.as_ref() == Some(&who);
        require!(is_buyer || is_cosigner, "ONLY_BUYER_OR_COSIGNER");
        if is_buyer {
            self.buyer_vote = Some(decision);
        }
        if is_cosigner {
            self.cosigner_vote = Some(decision);
        }
        emit(
            "clause_cosign",
            json!({ "clause_id": self.id, "by": who, "decision": decision }),
        );
        match (self.buyer_vote, self.cosigner_vote) {
            (Some(a), Some(b)) if a == b => PromiseOrValue::Promise(match a {
                Decision::Release => {
                    self.begin_payout(Payout::Release, self.payee.clone(), self.amount)
                }
                Decision::Return => self.begin_return(),
            }),
            _ => PromiseOrValue::Value(false),
        }
    }

    /// Anyone may call. Re-sends the terminal outcome to the factory. The
    /// factory ignores duplicates.
    pub fn report_outcome(&self) -> Promise {
        let outcome = match self.state {
            State::Released => Outcome::Released,
            State::Returned => Outcome::Returned,
            _ => env::panic_str("NOT_TERMINAL"),
        };
        self.record_outcome(outcome)
    }

    /// Anyone may call once the clause is settled and the factory has recorded
    /// it. The clause leaves the token (which fails while it still holds any,
    /// so run `sync_funding` first to sweep leftovers to the buyer), then
    /// deletes its own account. The NEAR that stored it goes back to the buyer.
    pub fn close(&mut self) -> Promise {
        require!(self.state.is_terminal(), "NOT_TERMINAL");
        require!(!self.settling, "SETTLING");
        require!(self.reported, "NOT_REPORTED");
        self.settling = true;
        ext_ft::ext(self.asset.clone())
            .with_static_gas(GAS_FT_STORAGE)
            .with_attached_deposit(ONE_YOCTO)
            .storage_unregister(Some(false))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_UNREGISTERED)
                    .on_unregistered(),
            )
    }

    // ------------------------------------------------------------ callbacks

    #[private]
    pub fn on_reported(&mut self) {
        if previous_ok() {
            self.reported = true;
        }
    }

    #[private]
    pub fn on_unregistered(&mut self) -> PromiseOrValue<bool> {
        if !previous_ok() {
            self.settling = false;
            emit(
                "clause_close_failed",
                json!({ "clause_id": self.id, "step": "storage_unregister" }),
            );
            return PromiseOrValue::Value(false);
        }
        emit(
            "clause_closed",
            json!({ "clause_id": self.id, "refund_to": self.buyer }),
        );
        PromiseOrValue::Promise(Promise::new(env::current_account_id()).delete_account(self.buyer.clone()))
    }

    #[private]
    pub fn on_return_balance(
        &mut self,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let Ok(U128(bal)) = balance else {
            self.settling = false;
            emit(
                "clause_settle_failed",
                json!({ "clause_id": self.id, "payout": Payout::Return, "step": "ft_balance_of" }),
            );
            return PromiseOrValue::Value(false);
        };
        self.known_balance = bal;
        if bal == 0 {
            self.settling = false;
            self.finish(Payout::Return, self.buyer.clone(), 0);
            return PromiseOrValue::Promise(self.record_outcome(Outcome::Returned));
        }
        PromiseOrValue::Promise(self.register_then_transfer(Payout::Return, self.buyer.clone(), bal))
    }

    #[private]
    pub fn on_registered(&mut self, payout: Payout, to: AccountId, amount: U128) -> PromiseOrValue<bool> {
        if !previous_ok() {
            self.settling = false;
            emit(
                "clause_settle_failed",
                json!({ "clause_id": self.id, "payout": payout, "step": "storage_deposit", "to": to }),
            );
            return PromiseOrValue::Value(false);
        }
        let memo = format!("clausehold r-{} {:?}", self.id, payout).to_lowercase();
        PromiseOrValue::Promise(
            ext_ft::ext(self.asset.clone())
                .with_static_gas(GAS_FT_TRANSFER)
                .with_attached_deposit(ONE_YOCTO)
                .ft_transfer(to.clone(), amount, Some(memo))
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_TRANSFERRED)
                        .on_transferred(payout, to, amount),
                ),
        )
    }

    #[private]
    pub fn on_transferred(&mut self, payout: Payout, to: AccountId, amount: U128) -> PromiseOrValue<bool> {
        self.settling = false;
        if !previous_ok() {
            emit(
                "clause_settle_failed",
                json!({ "clause_id": self.id, "payout": payout, "step": "ft_transfer", "to": to }),
            );
            return PromiseOrValue::Value(false);
        }
        self.known_balance = self.known_balance.saturating_sub(amount.0);
        self.finish(payout, to, amount.0);
        match payout {
            Payout::Release => PromiseOrValue::Promise(self.record_outcome(Outcome::Released)),
            Payout::Return => PromiseOrValue::Promise(self.record_outcome(Outcome::Returned)),
            Payout::Sweep => PromiseOrValue::Value(true),
        }
    }
}

impl Clause {
    fn mark_funded(&mut self) {
        self.state = State::Funded;
        emit(
            "clause_funded",
            json!({ "clause_id": self.id, "amount": U128(self.amount), "balance": U128(self.known_balance) }),
        );
    }

    fn begin_return(&mut self) -> Promise {
        self.settling = true;
        ext_ft::ext(self.asset.clone())
            .with_static_gas(GAS_FT_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_BALANCE)
                    .on_return_balance(),
            )
    }

    fn begin_payout(&mut self, payout: Payout, to: AccountId, amount: u128) -> Promise {
        self.settling = true;
        self.register_then_transfer(payout, to, amount)
    }

    /// storage_deposit(to) -> on_registered -> ft_transfer(to) -> on_transferred.
    /// State changes only in on_transferred, after the transfer succeeded.
    fn register_then_transfer(&mut self, payout: Payout, to: AccountId, amount: u128) -> Promise {
        ext_ft::ext(self.asset.clone())
            .with_static_gas(GAS_FT_STORAGE)
            .with_attached_deposit(FT_STORAGE_DEPOSIT)
            .storage_deposit(Some(to.clone()), Some(true))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REGISTERED)
                    .on_registered(payout, to, U128(amount)),
            )
    }

    fn finish(&mut self, payout: Payout, to: AccountId, amount: u128) {
        match payout {
            Payout::Release => {
                self.state = State::Released;
                self.paid = amount;
                emit(
                    "clause_released",
                    json!({ "clause_id": self.id, "payee": to, "amount": U128(amount) }),
                );
            }
            Payout::Return => {
                self.state = State::Returned;
                self.paid = amount;
                emit(
                    "clause_returned",
                    json!({ "clause_id": self.id, "buyer": to, "amount": U128(amount) }),
                );
            }
            Payout::Sweep => {
                emit(
                    "clause_swept",
                    json!({ "clause_id": self.id, "buyer": to, "amount": U128(amount) }),
                );
            }
        }
    }

    fn record_outcome(&self, outcome: Outcome) -> Promise {
        ext_factory::ext(self.factory.clone())
            .with_static_gas(GAS_RECORD_OUTCOME)
            .record_outcome(self.id, outcome, U128(self.paid))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REPORTED)
                    .on_reported(),
            )
    }
}

#[cfg(test)]
mod tests;
