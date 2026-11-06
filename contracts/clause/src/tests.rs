#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const SEC: u64 = 1_000_000_000;
const T0: u64 = 1_000_000 * SEC;
const AMOUNT: u128 = 2_000_000; // 2 USDC

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("r-0.clausehold.near")
}
fn factory() -> AccountId {
    acc("clausehold.near")
}
fn usdc() -> AccountId {
    acc("usdc.near")
}
fn buyer() -> AccountId {
    acc("buyer.near")
}
fn payee() -> AccountId {
    acc("payee.near")
}
fn cosigner() -> AccountId {
    acc("dao.near")
}
fn pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

fn ctx(pred: AccountId, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred)
        .block_timestamp(ts)
        .account_balance(NearToken::from_near(2));
    b
}

fn set(pred: AccountId, ts: u64) {
    testing_env!(ctx(pred, ts).build());
}

fn set_with_result(pred: AccountId, ts: u64, r: PromiseResult) {
    testing_env!(
        ctx(pred, ts).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

fn args(challenge_secs: u64) -> ClauseArgs {
    ClauseArgs {
        id: 0,
        buyer: buyer(),
        payee: payee(),
        worker_pk: pk(),
        asset: usdc(),
        amount: U128(AMOUNT),
        deadline: T0 / SEC + 900,
        terms_hash: "abc123".into(),
        challenge_secs,
        cosigner: Some(cosigner()),
    }
}

fn open(challenge_secs: u64) -> Clause {
    set(factory(), T0);
    Clause::new(args(challenge_secs))
}

fn funded(challenge_secs: u64) -> Clause {
    let mut c = open(challenge_secs);
    set(usdc(), T0);
    let r = c.ft_on_transfer(buyer(), U128(AMOUNT), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    c
}

fn delivered(challenge_secs: u64) -> Clause {
    let mut c = funded(challenge_secs);
    set(me(), T0 + 10 * SEC);
    c.submit_delivery("deliveryhash".into(), None);
    c
}

fn events() -> Vec<String> {
    get_logs()
        .into_iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:").map(str::to_string))
        .map(|j| {
            let v: serde_json::Value = serde_json::from_str(&j).unwrap();
            assert_eq!(v["standard"], EVENT_STANDARD);
            v["event"].as_str().unwrap().to_string()
        })
        .collect()
}

// ------------------------------------------------------------------- init

#[test]
fn init_by_parent_factory() {
    let c = open(0);
    let v = c.get_clause();
    assert_eq!(v.state, State::Open);
    assert_eq!(v.factory, factory());
    assert_eq!(v.amount, U128(AMOUNT));
    assert_eq!(events(), vec!["clause_open"]);
}

#[test]
#[should_panic(expected = "ONLY_FACTORY")]
fn init_by_stranger_fails() {
    set(acc("evil.near"), T0);
    Clause::new(args(0));
}

// ---------------------------------------------------------------- funding

#[test]
fn ft_on_transfer_returns_zero_when_funding() {
    let c = funded(0);
    assert_eq!(c.get_state(), State::Funded);
    assert!(events().contains(&"clause_funded".to_string()));
}

#[test]
fn ft_on_transfer_partial_then_excess() {
    let mut c = open(0);
    set(usdc(), T0);
    let r = c.ft_on_transfer(buyer(), U128(1_500_000), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(c.get_state(), State::Open);
    let r = c.ft_on_transfer(buyer(), U128(1_000_000), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(500_000))));
    assert_eq!(c.get_state(), State::Funded);
}

#[test]
fn ft_on_transfer_refunds_all_when_not_open() {
    let mut c = funded(0);
    set(usdc(), T0);
    let r = c.ft_on_transfer(buyer(), U128(7), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(7))));
}

#[test]
#[should_panic(expected = "WRONG_ASSET")]
fn ft_on_transfer_rejects_other_tokens() {
    let mut c = open(0);
    set(acc("fake-usdc.near"), T0);
    c.ft_on_transfer(buyer(), U128(AMOUNT), String::new());
}

#[test]
fn sync_funding_marks_funded() {
    let mut c = open(0);
    set_with_result(me(), T0, PromiseResult::Successful(b"\"2000000\"".to_vec()));
    c.on_sync_balance(Ok(U128(AMOUNT)));
    assert_eq!(c.get_state(), State::Funded);
}

#[test]
fn sync_funding_below_amount_stays_open() {
    let mut c = open(0);
    set(me(), T0);
    c.on_sync_balance(Ok(U128(AMOUNT - 1)));
    assert_eq!(c.get_state(), State::Open);
}

#[test]
fn sync_funding_in_terminal_state_sweeps_to_buyer() {
    let mut c = delivered(0);
    // Pretend the release chain finished.
    set_with_result(me(), T0 + 20 * SEC, PromiseResult::Successful(vec![]));
    c.on_transferred(Payout::Release, payee(), U128(AMOUNT));
    assert_eq!(c.get_state(), State::Released);
    // A late deposit arrives by plain ft_transfer; sync sees it.
    set(me(), T0 + 30 * SEC);
    let r = c.on_sync_balance(Ok(U128(5)));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert!(c.get_clause().settling);
    set_with_result(me(), T0 + 31 * SEC, PromiseResult::Successful(vec![]));
    c.on_transferred(Payout::Sweep, buyer(), U128(5));
    assert_eq!(c.get_state(), State::Released, "a sweep never changes the outcome");
    assert!(events().contains(&"clause_swept".to_string()));
}

// --------------------------------------------------------------- delivery

#[test]
#[should_panic(expected = "ONLY_WORKER_KEY")]
fn submit_delivery_from_other_account_fails() {
    let mut c = funded(0);
    set(payee(), T0 + SEC);
    c.submit_delivery("h".into(), None);
}

#[test]
#[should_panic(expected = "ONLY_WORKER_KEY")]
fn submit_delivery_from_factory_fails() {
    let mut c = funded(0);
    set(factory(), T0 + SEC);
    c.submit_delivery("h".into(), None);
}

#[test]
#[should_panic(expected = "NOT_FUNDED")]
fn submit_delivery_before_funding_fails() {
    let mut c = open(0);
    set(me(), T0 + SEC);
    c.submit_delivery("h".into(), None);
}

#[test]
#[should_panic(expected = "DEADLINE_PASSED")]
fn submit_delivery_after_deadline_fails() {
    let mut c = funded(0);
    set(me(), T0 + 901 * SEC);
    c.submit_delivery("h".into(), None);
}

#[test]
fn submit_delivery_with_zero_window_releases_in_same_call() {
    let mut c = funded(0);
    set(me(), T0 + SEC);
    let r = c.submit_delivery("h".into(), Some("note".into()));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    let v = c.get_clause();
    assert_eq!(v.state, State::Delivered);
    assert!(v.settling, "payout chain started");
    assert_eq!(v.note_hash.as_deref(), Some("note"));
}

#[test]
fn submit_delivery_with_window_waits() {
    let mut c = funded(120);
    set(me(), T0 + SEC);
    let r = c.submit_delivery("h".into(), None);
    assert!(matches!(r, PromiseOrValue::Value(true)));
    assert!(!c.get_clause().settling);
}

// ---------------------------------------------------------------- release

#[test]
#[should_panic(expected = "CHALLENGE_WINDOW_OPEN")]
fn release_inside_window_fails() {
    let mut c = delivered(120);
    set(acc("anyone.near"), T0 + 60 * SEC);
    c.release();
}

#[test]
fn release_after_window_by_anyone() {
    let mut c = delivered(120);
    set(acc("anyone.near"), T0 + 131 * SEC);
    c.release();
    assert!(c.get_clause().settling);
}

#[test]
#[should_panic(expected = "SETTLING")]
fn double_release_is_blocked() {
    let mut c = delivered(120);
    set(acc("anyone.near"), T0 + 131 * SEC);
    c.release();
    c.release();
}

#[test]
fn failed_ft_transfer_leaves_clause_retryable() {
    let mut c = delivered(120);
    set(acc("anyone.near"), T0 + 131 * SEC);
    c.release();
    set_with_result(me(), T0 + 132 * SEC, PromiseResult::Failed);
    let r = c.on_transferred(Payout::Release, payee(), U128(AMOUNT));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    let v = c.get_clause();
    assert_eq!(v.state, State::Delivered);
    assert!(!v.settling);
    assert!(events().contains(&"clause_settle_failed".to_string()));
    // Retry works.
    set(acc("anyone.near"), T0 + 140 * SEC);
    c.release();
    set_with_result(me(), T0 + 141 * SEC, PromiseResult::Successful(vec![]));
    c.on_transferred(Payout::Release, payee(), U128(AMOUNT));
    assert_eq!(c.get_state(), State::Released);
    assert_eq!(c.get_clause().paid, U128(AMOUNT));
}

#[test]
fn failed_storage_deposit_leaves_clause_retryable() {
    let mut c = delivered(120);
    set(acc("anyone.near"), T0 + 131 * SEC);
    c.release();
    set_with_result(me(), T0 + 132 * SEC, PromiseResult::Failed);
    let r = c.on_registered(Payout::Release, payee(), U128(AMOUNT));
    assert!(matches!(r, PromiseOrValue::Value(false)));
    assert_eq!(c.get_state(), State::Delivered);
    assert!(!c.get_clause().settling);
}

#[test]
fn successful_registration_schedules_transfer() {
    let mut c = delivered(120);
    set(acc("anyone.near"), T0 + 131 * SEC);
    c.release();
    set_with_result(me(), T0 + 132 * SEC, PromiseResult::Successful(b"{}".to_vec()));
    let r = c.on_registered(Payout::Release, payee(), U128(AMOUNT));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(c.get_state(), State::Delivered, "state moves only after ft_transfer");
}

// ----------------------------------------------------------------- expire

#[test]
#[should_panic(expected = "NOT_EXPIRED")]
fn expire_before_deadline_fails() {
    let mut c = funded(0);
    set(acc("anyone.near"), T0 + 899 * SEC);
    c.expire();
}

#[test]
fn expire_after_deadline_returns_balance_to_buyer() {
    let mut c = funded(0);
    set(acc("anyone.near"), T0 + 900 * SEC);
    c.expire();
    assert!(c.get_clause().settling);
    set_with_result(me(), T0 + 901 * SEC, PromiseResult::Successful(b"\"2000000\"".to_vec()));
    let r = c.on_return_balance(Ok(U128(AMOUNT)));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    set_with_result(me(), T0 + 902 * SEC, PromiseResult::Successful(vec![]));
    c.on_transferred(Payout::Return, buyer(), U128(AMOUNT));
    assert_eq!(c.get_state(), State::Returned);
}

#[test]
fn expire_unfunded_with_zero_balance_returns_without_transfer() {
    let mut c = open(0);
    set(acc("anyone.near"), T0 + 900 * SEC);
    c.expire();
    set(me(), T0 + 901 * SEC);
    c.on_return_balance(Ok(U128(0)));
    assert_eq!(c.get_state(), State::Returned);
    assert!(!c.get_clause().settling);
}

#[test]
#[should_panic(expected = "NOT_EXPIRABLE")]
fn no_expire_after_delivery() {
    // There is no withdraw path once delivered: expire refuses too.
    let mut c = delivered(120);
    set(buyer(), T0 + 10_000 * SEC);
    c.expire();
}

#[test]
#[should_panic(expected = "NOT_EXPIRABLE")]
fn no_expire_after_release() {
    let mut c = delivered(0);
    set_with_result(me(), T0 + 20 * SEC, PromiseResult::Successful(vec![]));
    c.on_transferred(Payout::Release, payee(), U128(AMOUNT));
    set(buyer(), T0 + 10_000 * SEC);
    c.expire();
}

// ---------------------------------------------------------- freeze/cosign

#[test]
#[should_panic(expected = "ONLY_BUYER")]
fn freeze_by_non_buyer_fails() {
    let mut c = delivered(120);
    set(payee(), T0 + 20 * SEC);
    c.freeze();
}

#[test]
#[should_panic(expected = "CHALLENGE_WINDOW_CLOSED")]
fn freeze_after_window_fails() {
    let mut c = delivered(120);
    set(buyer(), T0 + 131 * SEC);
    c.freeze();
}

#[test]
#[should_panic(expected = "NOT_DELIVERED")]
fn freeze_before_delivery_fails() {
    let mut c = funded(120);
    set(buyer(), T0 + 20 * SEC);
    c.freeze();
}

#[test]
fn freeze_then_cosign_needs_both_votes() {
    let mut c = delivered(120);
    set(buyer(), T0 + 20 * SEC);
    c.freeze();
    assert_eq!(c.get_state(), State::Frozen);

    // Release is blocked while frozen.
    set(buyer(), T0 + 30 * SEC);
    let r = c.cosign(Decision::Return);
    assert!(matches!(r, PromiseOrValue::Value(false)));
    set(cosigner(), T0 + 31 * SEC);
    let r = c.cosign(Decision::Release);
    assert!(matches!(r, PromiseOrValue::Value(false)), "votes disagree");
    set(cosigner(), T0 + 32 * SEC);
    let r = c.cosign(Decision::Return);
    assert!(matches!(r, PromiseOrValue::Promise(_)), "votes agree, return starts");
    assert!(c.get_clause().settling);
}

#[test]
#[should_panic(expected = "NOT_DELIVERED")]
fn release_while_frozen_fails() {
    let mut c = delivered(120);
    set(buyer(), T0 + 20 * SEC);
    c.freeze();
    set(acc("anyone.near"), T0 + 500 * SEC);
    c.release();
}

#[test]
#[should_panic(expected = "ONLY_BUYER_OR_COSIGNER")]
fn cosign_by_stranger_fails() {
    let mut c = delivered(120);
    set(buyer(), T0 + 20 * SEC);
    c.freeze();
    set(payee(), T0 + 21 * SEC);
    c.cosign(Decision::Release);
}

#[test]
#[should_panic(expected = "NO_COSIGNER")]
fn freeze_without_cosigner_fails() {
    set(factory(), T0);
    let mut a = args(120);
    a.cosigner = None;
    let mut c = Clause::new(a);
    set(usdc(), T0);
    c.ft_on_transfer(buyer(), U128(AMOUNT), String::new());
    set(me(), T0 + SEC);
    c.submit_delivery("h".into(), None);
    set(buyer(), T0 + 2 * SEC);
    c.freeze();
}

#[test]
#[should_panic(expected = "NOT_TERMINAL")]
fn report_outcome_needs_terminal_state() {
    let c = funded(0);
    c.report_outcome();
}
