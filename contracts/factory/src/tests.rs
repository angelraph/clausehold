#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const SEC: u64 = 1_000_000_000;
const T0: u64 = 20_000 * 86_400 * SEC + 3_600 * SEC;
const USDC: u128 = 1_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("clausehold.near")
}
fn owner() -> AccountId {
    acc("dao.sputnik-dao.near")
}
fn desk() -> AccountId {
    acc("desk.near")
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
fn pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}

const FAKE_CODE: &[u8] = b"\0asm\x01\0\0\0 fake clause code for unit tests";

fn ctx(pred: AccountId, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(pred.clone())
        .signer_account_id(pred)
        .block_timestamp(T0)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(100));
    b
}

fn set(pred: AccountId) {
    testing_env!(ctx(pred, NearToken::from_yoctonear(0)).build());
}

fn set_deposit(pred: AccountId, deposit: NearToken) {
    testing_env!(ctx(pred, deposit).build());
}

fn set_with_result(pred: AccountId, r: PromiseResult) {
    testing_env!(
        ctx(pred, NearToken::from_yoctonear(0)).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![r]
    );
}

fn mandate() -> Mandate {
    Mandate {
        allowed_assets: vec![usdc()],
        max_per_clause: U128(5 * USDC),
        per_payee_daily_cap: U128(6 * USDC),
        daily_cap: U128(10 * USDC),
        new_payee_ceiling: U128(3 * USDC),
        paused: false,
        cosigner: Some(acc("cosigner.near")),
        creators: vec![],
    }
}

fn factory() -> Factory {
    set(owner());
    let f = Factory::new(owner(), Some(mandate()));
    f.store_clause_code(FAKE_CODE);
    f
}

fn need() -> NearToken {
    required_deposit(FAKE_CODE.len() as u64)
}

fn create(f: &mut Factory, payee_id: AccountId, amount: u128) -> u64 {
    set_deposit(desk(), need());
    let id = f.clause_count();
    f.create_clause(
        buyer(),
        payee_id,
        pk(),
        usdc(),
        U128(amount),
        T0 / SEC + 900,
        "terms".into(),
        0,
    );
    id
}

fn live(f: &mut Factory, payee_id: AccountId, amount: u128) -> u64 {
    let id = create(f, payee_id, amount);
    set_with_result(me(), PromiseResult::Successful(vec![]));
    f.on_clause_created(id, desk(), U128(0));
    id
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

// ------------------------------------------------------------- mandate

#[test]
fn set_mandate_by_owner() {
    let mut f = factory();
    set(owner());
    let mut m = mandate();
    m.paused = true;
    f.set_mandate(m.clone());
    assert_eq!(f.get_mandate(), Some(m));
    assert!(events().contains(&"mandate_set".to_string()));
}

#[test]
#[should_panic(expected = "ONLY_OWNER")]
fn set_mandate_by_stranger_fails() {
    let mut f = factory();
    set(desk());
    f.set_mandate(mandate());
}

#[test]
#[should_panic(expected = "ONLY_OWNER")]
fn set_clause_code_by_stranger_fails() {
    let f = factory();
    set(desk());
    f.store_clause_code(FAKE_CODE);
}

#[test]
fn set_owner_hands_over() {
    let mut f = factory();
    set(owner());
    f.set_owner(acc("new.near"));
    assert_eq!(f.get_owner(), acc("new.near"));
}

#[test]
fn code_info_reports_hash() {
    let f = factory();
    let info = f.clause_code_info().unwrap();
    assert_eq!(info.len, FAKE_CODE.len() as u64);
    assert_eq!(info.sha256.len(), 64);
    assert_eq!(f.create_deposit(), U128(need().as_yoctonear()));
}

// -------------------------------------------------------------- create

#[test]
fn create_reserves_and_records() {
    let mut f = factory();
    let id = create(&mut f, payee(), 2 * USDC);
    let rec = f.get_clause(id).unwrap();
    assert_eq!(rec.account_id, acc("r-0.clausehold.near"));
    assert_eq!(rec.status, ClauseStatus::Pending);
    let u = f.usage(payee());
    assert_eq!(u.daily_used, U128(2 * USDC));
    assert_eq!(u.payee_used, U128(2 * USDC));

    set_with_result(me(), PromiseResult::Successful(vec![]));
    let r = f.on_clause_created(id, desk(), U128(0));
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    assert_eq!(f.get_clause(id).unwrap().status, ClauseStatus::Live);
    assert_eq!(f.standing(payee()).as_payee.open, 1);
    assert!(events().contains(&"clause_created".to_string()));
}

#[test]
fn second_clause_gets_next_id() {
    let mut f = factory();
    live(&mut f, payee(), USDC);
    let id = create(&mut f, payee(), USDC);
    assert_eq!(f.get_clause(id).unwrap().account_id, acc("r-1.clausehold.near"));
}

#[test]
fn failed_account_creation_gives_reservation_back() {
    let mut f = factory();
    let id = create(&mut f, payee(), 2 * USDC);
    set_with_result(me(), PromiseResult::Failed);
    let r = f.on_clause_created(id, desk(), U128(need().as_yoctonear()));
    assert!(matches!(r, PromiseOrValue::Value(None)));
    assert_eq!(f.get_clause(id).unwrap().status, ClauseStatus::Failed);
    assert_eq!(f.usage(payee()).daily_used, U128(0));
    assert_eq!(f.usage(payee()).payee_used, U128(0));
    assert!(events().contains(&"clause_failed".to_string()));
}

#[test]
#[should_panic(expected = "MANDATE:paused")]
fn paused_mandate_refuses() {
    let mut f = factory();
    set(owner());
    let mut m = mandate();
    m.paused = true;
    f.set_mandate(m);
    create(&mut f, payee(), USDC);
}

#[test]
#[should_panic(expected = "MANDATE:allowed_assets")]
fn other_asset_refused() {
    let mut f = factory();
    set_deposit(desk(), need());
    f.create_clause(buyer(), payee(), pk(), acc("fake.near"), U128(USDC), T0 / SEC + 900, "t".into(), 0);
}

#[test]
#[should_panic(expected = "MANDATE:max_per_clause")]
fn over_max_per_clause_refused() {
    let mut f = factory();
    create(&mut f, payee(), 5 * USDC + 1);
}

#[test]
#[should_panic(expected = "MANDATE:new_payee_ceiling")]
fn new_payee_over_ceiling_refused() {
    let mut f = factory();
    create(&mut f, payee(), 3 * USDC + 1);
}

#[test]
fn known_payee_may_exceed_new_payee_ceiling() {
    let mut f = factory();
    let id = live(&mut f, payee(), USDC);
    set(acc("r-0.clausehold.near"));
    f.record_outcome(id, Outcome::Released, U128(USDC));
    create(&mut f, payee(), 4 * USDC);
}

#[test]
#[should_panic(expected = "MANDATE:per_payee_daily_cap")]
fn reservation_blocks_next_clause_per_payee() {
    let mut f = factory();
    // 3 + 3 = 6 is the per-payee cap. Neither has been funded or released:
    // the reservation alone blocks the third.
    live(&mut f, payee(), 3 * USDC);
    live(&mut f, payee(), 3 * USDC);
    create(&mut f, payee(), 1);
}

#[test]
#[should_panic(expected = "MANDATE:daily_cap")]
fn reservation_blocks_next_clause_daily() {
    let mut f = factory();
    live(&mut f, acc("p1.near"), 3 * USDC);
    live(&mut f, acc("p2.near"), 3 * USDC);
    live(&mut f, acc("p3.near"), 3 * USDC);
    create(&mut f, acc("p4.near"), 2 * USDC);
}

#[test]
#[should_panic(expected = "MANDATE:creators")]
fn creator_allowlist_enforced() {
    let mut f = factory();
    set(owner());
    let mut m = mandate();
    m.creators = vec![acc("other-desk.near")];
    f.set_mandate(m);
    create(&mut f, payee(), USDC);
}

#[test]
#[should_panic(expected = "MANDATE:not_set")]
fn no_mandate_refuses() {
    set(owner());
    let mut f = Factory::new(owner(), None);
    f.store_clause_code(FAKE_CODE);
    create(&mut f, payee(), USDC);
}

#[test]
#[should_panic(expected = "DEPOSIT_TOO_LOW")]
fn deposit_too_low_refused() {
    let mut f = factory();
    set_deposit(desk(), need().saturating_sub(NearToken::from_yoctonear(1)));
    f.create_clause(buyer(), payee(), pk(), usdc(), U128(USDC), T0 / SEC + 900, "t".into(), 0);
}

#[test]
#[should_panic(expected = "PAYEE_NOT_NAMED")]
fn implicit_payee_refused() {
    let mut f = factory();
    create(&mut f, acc(&"a".repeat(64)), USDC);
}

#[test]
#[should_panic(expected = "DEADLINE_IN_PAST")]
fn past_deadline_refused() {
    let mut f = factory();
    set_deposit(desk(), need());
    f.create_clause(buyer(), payee(), pk(), usdc(), U128(USDC), T0 / SEC - 1, "t".into(), 0);
}

#[test]
#[should_panic(expected = "NO_CLAUSE_CODE")]
fn no_code_refused() {
    set(owner());
    let mut f = Factory::new(owner(), Some(mandate()));
    create(&mut f, payee(), USDC);
}

// ------------------------------------------------------------- outcome

#[test]
#[should_panic(expected = "ONLY_OWN_CLAUSE")]
fn record_outcome_from_stranger_fails() {
    let mut f = factory();
    let id = live(&mut f, payee(), USDC);
    set(acc("r-9.clausehold.near"));
    f.record_outcome(id, Outcome::Released, U128(USDC));
}

#[test]
fn released_keeps_reservation_and_writes_receipt() {
    let mut f = factory();
    let id = live(&mut f, payee(), 2 * USDC);
    set(acc("r-0.clausehold.near"));
    assert!(f.record_outcome(id, Outcome::Released, U128(2 * USDC)));
    assert_eq!(f.usage(payee()).payee_used, U128(2 * USDC));
    let s = f.standing(payee());
    assert_eq!(s.as_payee.released, 1);
    assert_eq!(s.as_payee.open, 0);
    assert_eq!(s.as_payee.released_volume, U128(2 * USDC));
    assert_eq!(f.standing(buyer()).as_buyer.released, 1);
    let r = f.get_receipts(Some(payee()), None, None);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].outcome, Outcome::Released);
    assert_eq!(f.get_receipts(Some(buyer()), None, None).len(), 1);
    assert_eq!(f.get_receipts(None, None, None).len(), 1);
    assert!(events().contains(&"outcome_recorded".to_string()));
}

#[test]
fn returned_gives_reservation_back() {
    let mut f = factory();
    let id = live(&mut f, payee(), 2 * USDC);
    set(acc("r-0.clausehold.near"));
    f.record_outcome(id, Outcome::Returned, U128(2 * USDC));
    assert_eq!(f.usage(payee()).payee_used, U128(0));
    assert_eq!(f.usage(payee()).daily_used, U128(0));
    assert_eq!(f.standing(payee()).as_payee.returned, 1);
    assert_eq!(f.get_clause(id).unwrap().status, ClauseStatus::Returned);
}

#[test]
fn record_outcome_is_idempotent() {
    let mut f = factory();
    let id = live(&mut f, payee(), 2 * USDC);
    set(acc("r-0.clausehold.near"));
    assert!(f.record_outcome(id, Outcome::Returned, U128(2 * USDC)));
    assert!(!f.record_outcome(id, Outcome::Returned, U128(2 * USDC)));
    assert!(!f.record_outcome(id, Outcome::Released, U128(2 * USDC)));
    assert_eq!(f.standing(payee()).as_payee.returned, 1);
    assert_eq!(f.get_receipts(None, None, None).len(), 1);
}

#[test]
fn named_account_check() {
    assert!(is_named(&acc("alice.near")));
    assert!(is_named(&acc("alice")));
    assert!(!is_named(&acc(&"0".repeat(64))));
    assert!(!is_named(&acc("0x1234567890123456789012345678901234567890")));
}

#[test]
fn cancelled_frees_reservation_without_touching_standing() {
    let mut f = factory();
    let id = live(&mut f, payee(), 2 * USDC);
    assert_eq!(f.usage(payee()).daily_used, U128(2 * USDC));
    set(acc("r-0.clausehold.near"));
    assert!(f.record_outcome(id, Outcome::Cancelled, U128(0)));
    assert_eq!(f.usage(payee()).payee_used, U128(0));
    assert_eq!(f.usage(payee()).daily_used, U128(0));
    let s = f.standing(payee());
    assert_eq!((s.as_payee.open, s.as_payee.returned, s.as_payee.released), (0, 0, 0));
    let b = f.standing(buyer());
    assert_eq!((b.as_buyer.open, b.as_buyer.returned), (0, 0));
    assert_eq!(f.get_clause(id).unwrap().status, ClauseStatus::Returned);
    assert!(f.get_receipts(None, None, None).is_empty());
    assert!(events().contains(&"clause_cancelled".to_string()));
    // A duplicate report changes nothing.
    assert!(!f.record_outcome(id, Outcome::Cancelled, U128(0)));
}

#[test]
fn cancelled_clause_makes_room_for_the_next() {
    let mut f = factory();
    // A spammer fills most of the day's cap (10) with unfunded clauses.
    let ids: Vec<u64> = ["a.near", "b.near", "c.near"]
        .iter()
        .map(|p| live(&mut f, acc(p), 3 * USDC))
        .collect();
    assert_eq!(f.usage(payee()).daily_used, U128(9 * USDC));
    // One of them is cancelled after its funding window.
    set(acc(&format!("r-{}.clausehold.near", ids[0])));
    assert!(f.record_outcome(ids[0], Outcome::Cancelled, U128(0)));
    assert_eq!(f.usage(payee()).daily_used, U128(6 * USDC));
    // A real job for 3 now fits the same day (9 + 3 would not have).
    live(&mut f, payee(), 3 * USDC);
    assert_eq!(f.usage(payee()).daily_used, U128(9 * USDC));
}