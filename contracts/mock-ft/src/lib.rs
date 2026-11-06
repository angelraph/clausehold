//! Test-only NEP-141 token with NEP-145 registration.
//! `mint` is open to anyone. `set_fail_transfers(true)` makes `ft_transfer`
//! panic, to prove a failed payout leaves a clause retryable. Do not deploy
//! anywhere that matters.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

const STORAGE_MIN: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
const GAS_ON_TRANSFER: Gas = Gas::from_tgas(60);
const GAS_RESOLVE: Gas = Gas::from_tgas(10);

#[ext_contract(ext_receiver)]
#[allow(dead_code)]
trait Receiver {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128>;
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    balances: LookupMap<AccountId, u128>,
    total_supply: u128,
    fail_transfers: bool,
    fail_storage: bool,
}

#[near]
impl MockFt {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            total_supply: 0,
            fail_transfers: false,
            fail_storage: false,
        }
    }

    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        let b = self.balances.entry(account_id).or_insert(0);
        *b += amount.0;
        self.total_supply += amount.0;
    }

    pub fn set_fail_transfers(&mut self, fail: bool) {
        self.fail_transfers = fail;
    }

    pub fn set_fail_storage(&mut self, fail: bool) {
        self.fail_storage = fail;
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.total_supply)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balances.get(&account_id).copied().unwrap_or(0))
    }

    pub fn ft_metadata(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "spec": "ft-1.0.0", "name": "Mock USD", "symbol": "mUSD", "decimals": 6
        })
    }

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "REQUIRES_ONE_YOCTO");
        require!(!self.fail_transfers, "MOCK_TRANSFER_FAILURE");
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, amount.0);
        log!("transfer {} from {} to {} memo {:?}", amount.0, sender, receiver_id, memo);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "REQUIRES_ONE_YOCTO");
        let _ = memo;
        let sender = env::predecessor_account_id();
        self.move_tokens(&sender, &receiver_id, amount.0);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_ON_TRANSFER)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
    }

    /// Returns the amount actually used by the receiver.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        if unused > 0 {
            let have = self.balances.get(&receiver_id).copied().unwrap_or(0);
            let back = unused.min(have);
            if back > 0 {
                self.move_tokens(&receiver_id, &sender_id, back);
            }
            return U128(amount.0 - back);
        }
        amount
    }

    // NEP-145
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        let _ = registration_only;
        require!(!self.fail_storage, "MOCK_STORAGE_FAILURE");
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        if self.balances.contains_key(&account) {
            if !deposit.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
            }
        } else {
            require!(deposit >= STORAGE_MIN, "INSUFFICIENT_STORAGE_DEPOSIT");
            self.balances.insert(account, 0);
            let refund = deposit.saturating_sub(STORAGE_MIN);
            if !refund.is_zero() {
                Promise::new(env::predecessor_account_id()).transfer(refund).detach();
            }
        }
        StorageBalance { total: U128(STORAGE_MIN.as_yoctonear()), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.balances
            .contains_key(&account_id)
            .then(|| StorageBalance { total: U128(STORAGE_MIN.as_yoctonear()), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_MIN.as_yoctonear()), max: Some(U128(STORAGE_MIN.as_yoctonear())) }
    }
}

impl MockFt {
    fn move_tokens(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        require!(amount > 0, "ZERO_AMOUNT");
        require!(self.balances.contains_key(to), "RECEIVER_NOT_REGISTERED");
        let fb = self.balances.get(from).copied().unwrap_or_else(|| env::panic_str("SENDER_NOT_REGISTERED"));
        require!(fb >= amount, "INSUFFICIENT_BALANCE");
        self.balances.insert(from.clone(), fb - amount);
        *self.balances.get_mut(to).unwrap() += amount;
    }
}
