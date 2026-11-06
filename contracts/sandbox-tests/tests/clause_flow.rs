#![allow(unused_must_use)]
//! near-workspaces sandbox tests: factory + clause + mock NEP-141.
//! Build the wasm first (contracts/README.md), then `cargo test -p sandbox-tests`.

mod common;

use anyhow::Result;
use common::relay::{relay, submit_delivery, Inner};
use common::*;
use near_workspaces::types::AccessKeyPermission;
use near_workspaces::Account;
use serde_json::{json, Value};

fn worker_account(env: &Env, c: &Created) -> Account {
    env.account_with_key(c.account.clone(), c.worker_sk.clone())
}

#[tokio::test]
async fn happy_path_relayed_delivery_releases_in_same_call() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 0).await?.expect("create");
    assert_eq!(c.account.as_str(), format!("r-0.{}", env.factory.id()));

    // Exactly one access key: a function-call key for submit_delivery on r-0.
    let keys = env.access_keys(&c.account).await?;
    assert_eq!(keys.len(), 1, "exactly one key: {keys:?}");
    assert_eq!(keys[0].public_key, c.worker_sk.public_key());
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(fc) => {
            assert_eq!(fc.receiver_id.as_str(), c.account.as_str());
            assert_eq!(fc.method_names, vec!["submit_delivery".to_string()]);
        }
        other => panic!("worker key must be function-call only, got {other:?}"),
    }

    // The factory registered r-0 on the FT.
    let reg: Option<Value> = env
        .ft
        .view("storage_balance_of")
        .args_json(json!({ "account_id": c.account }))
        .await?
        .json()?;
    assert!(reg.is_some(), "clause registered with the FT");

    // ft_transfer_call: ft_on_transfer returns 0, so all tokens are kept.
    let before = balance(&env, env.buyer.id()).await?;
    let r = ok(fund_call(&env, &c.account, 2 * USDC).await?)?;
    let used: String = r.json()?;
    assert_eq!(used, (2 * USDC).to_string(), "ft_on_transfer returned 0, all used");
    assert_eq!(balance(&env, env.buyer.id()).await?, before - 2 * USDC);
    assert_eq!(state(&env, &c.account).await?, "funded");

    // The worker signs a delegate with the FC key; a third account relays it.
    let out = relay(&env, &c.account, &c.worker_sk, &c.account, submit_delivery("cut-v1"), &env.relayer).await?;
    assert!(out.ok, "relayed delivery must succeed: {}", out.detail);

    let v = clause_view(&env, &c.account).await?;
    assert_eq!(v["state"], "released");
    assert_eq!(v["delivery_hash"], "cut-v1");
    assert_eq!(balance(&env, env.payee.id()).await?, 2 * USDC);
    assert_eq!(balance(&env, &c.account).await?, 0);

    // Public receipt and standing on the factory.
    let receipts: Vec<Value> = env
        .factory
        .view("get_receipts")
        .args_json(json!({ "account_id": env.payee.id() }))
        .await?
        .json()?;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0]["outcome"], "released");
    let s: Value = env
        .factory
        .view("standing")
        .args_json(json!({ "account_id": env.payee.id() }))
        .await?
        .json()?;
    assert_eq!(s["as_payee"]["released"], 1);
    assert_eq!(s["as_payee"]["open"], 0);
    Ok(())
}

#[tokio::test]
async fn direct_submit_delivery_from_any_other_account_fails() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 0).await?.expect("create");
    ok(fund_call(&env, &c.account, 2 * USDC).await?)?;

    for who in [&env.payee, &env.buyer, &env.relayer, &env.stranger, &env.desk, &env.dao] {
        let r = who
            .call(&c.account, "submit_delivery")
            .args_json(json!({ "hash": "forged" }))
            .max_gas()
            .transact()
            .await?;
        assert!(r.is_failure(), "{} must not deliver", who.id());
        assert!(failure_text(&r).contains("ONLY_WORKER_KEY"), "{}", failure_text(&r));
    }
    // The factory itself cannot either (it has no method that would try).
    assert_eq!(state(&env, &c.account).await?, "funded");
    assert_eq!(balance(&env, env.payee.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn worker_key_can_only_call_submit_delivery() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 120).await?.expect("create");
    ok(fund_call(&env, &c.account, 2 * USDC).await?)?;
    let w = worker_account(&env, &c);

    // Direct transactions signed by the worker key.
    for method in ["release", "expire", "sync_funding", "freeze", "report_outcome", "ensure_registered"] {
        let r = w.call(&c.account, method).args_json(json!({})).max_gas().transact().await;
        let failed = match r {
            Err(_) => true, // rejected as an invalid transaction
            Ok(r) => r.is_failure(),
        };
        assert!(failed, "worker key must not call {method}");
    }
    // A call to another contract (the FT) with the worker key.
    let r = w
        .call(env.ft.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": env.stranger.id(), "amount": "1" }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .transact()
        .await;
    assert!(r.map(|r| r.is_failure()).unwrap_or(true), "worker key cannot call the FT");

    // Delegates for anything other than submit_delivery on r-0 also fail.
    let bad = relay(
        &env,
        &c.account,
        &c.worker_sk,
        &c.account,
        Inner::Call { method: "release".into(), args: json!({}) },
        &env.relayer,
    )
    .await?;
    assert!(!bad.ok, "delegated release must fail");
    let bad = relay(&env, &c.account, &c.worker_sk, env.ft.id(), Inner::Call {
        method: "ft_transfer".into(),
        args: json!({ "receiver_id": env.stranger.id(), "amount": "1" }),
    }, &env.relayer)
    .await?;
    assert!(!bad.ok, "delegated FT call must fail");
    let bad = relay(&env, &c.account, &c.worker_sk, env.stranger.id(), Inner::Transfer { yocto: 1 }, &env.relayer).await?;
    assert!(!bad.ok, "delegated NEAR transfer must fail");

    assert_eq!(state(&env, &c.account).await?, "funded");
    assert_eq!(balance(&env, &c.account).await?, 2 * USDC);

    // The worker key works directly too, paying gas from its allowance.
    ok(w.call(&c.account, "submit_delivery")
        .args_json(json!({ "hash": "direct" }))
        .max_gas()
        .transact()
        .await?)?;
    assert_eq!(state(&env, &c.account).await?, "delivered");
    Ok(())
}

#[tokio::test]
async fn no_withdraw_path_after_delivery() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 120).await?.expect("create");
    ok(fund_call(&env, &c.account, 2 * USDC).await?)?;
    let out = relay(&env, &c.account, &c.worker_sk, &c.account, submit_delivery("h"), &env.relayer).await?;
    assert!(out.ok, "{}", out.detail);
    assert_eq!(state(&env, &c.account).await?, "delivered");

    for (who, method) in [
        (&env.buyer, "expire"),
        (&env.buyer, "withdraw"),
        (&env.dao, "withdraw"),
        (&env.desk, "ft_transfer"),
        (&env.buyer, "release"), // window still open
    ] {
        let r = call0(who, &c.account, method).await?;
        assert!(r.is_failure(), "{} calling {method} must fail", who.id());
    }
    // A forged callback is rejected: callbacks are #[private].
    let r = env
        .stranger
        .call(&c.account, "on_transferred")
        .args_json(json!({ "payout": "release", "to": env.stranger.id(), "amount": "2000000" }))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_failure());
    assert_eq!(balance(&env, &c.account).await?, 2 * USDC);

    // After the window, anyone releases, and only to the payee.
    advance_secs(&env, 125).await?;
    ok(call0(&env.stranger, &c.account, "release").await?)?;
    assert_eq!(state(&env, &c.account).await?, "released");
    assert_eq!(balance(&env, env.payee.id()).await?, 2 * USDC);
    assert_eq!(balance(&env, env.stranger.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn over_mandate_create_panics_and_reservation_blocks_next() -> Result<()> {
    let env = setup().await?;

    let err = create_clause(&env, env.payee.id(), 5 * USDC + 1, 900, 0).await?.err().expect("refused");
    assert!(err.contains("MANDATE:max_per_clause"), "{err}");

    let r = env
        .desk
        .call(env.factory.id(), "create_clause")
        .args_json(json!({
            "buyer": env.buyer.id(), "payee": env.payee.id(),
            "worker_pk": near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519).public_key(),
            "asset": env.stranger.id(), "amount": "1", "deadline": now_secs(&env).await? + 900,
            "terms_hash": "t", "challenge_secs": 0,
        }))
        .deposit(near_workspaces::types::NearToken::from_near(5))
        .max_gas()
        .transact()
        .await?;
    assert!(failure_text(&r).contains("MANDATE:allowed_assets"));

    // per_payee_daily_cap is 6 USDC: 3 + 3 reserves it, unfunded.
    create_clause(&env, env.payee.id(), 3 * USDC, 900, 0).await?.expect("first");
    create_clause(&env, env.payee.id(), 3 * USDC, 900, 0).await?.expect("second");
    let err = create_clause(&env, env.payee.id(), 1, 900, 0).await?.err().expect("third refused");
    assert!(err.contains("MANDATE:per_payee_daily_cap"), "{err}");

    // Pausing through the owner (the DAO) refuses everything.
    let mut m = mandate(env.ft.id(), env.cosigner.id());
    m["paused"] = json!(true);
    ok(env.dao.call(env.factory.id(), "set_mandate").args_json(json!({ "mandate": m })).transact().await?)?;
    let err = create_clause(&env, env.stranger.id(), 1, 900, 0).await?.err().expect("paused");
    assert!(err.contains("MANDATE:paused"), "{err}");

    // Only the owner sets the mandate.
    let r = env
        .desk
        .call(env.factory.id(), "set_mandate")
        .args_json(json!({ "mandate": mandate(env.ft.id(), env.cosigner.id()) }))
        .transact()
        .await?;
    assert!(failure_text(&r).contains("ONLY_OWNER"));
    Ok(())
}

#[tokio::test]
async fn expire_returns_to_buyer_and_frees_reservation() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 3 * USDC, 60, 0).await?.expect("create");
    // Funded the 1Click way: a plain ft_transfer, then sync_funding.
    fund_plain(&env, &c.account, 3 * USDC).await?;
    assert_eq!(state(&env, &c.account).await?, "open");
    ok(call0(&env.stranger, &c.account, "sync_funding").await?)?;
    assert_eq!(state(&env, &c.account).await?, "funded");

    let r = call0(&env.stranger, &c.account, "expire").await?;
    assert!(failure_text(&r).contains("NOT_EXPIRED"), "expire before deadline fails");

    let usage: Value = env.factory.view("usage").args_json(json!({ "payee": env.payee.id() })).await?.json()?;
    assert_eq!(usage["payee_used"], (3 * USDC).to_string());

    advance_secs(&env, 65).await?;
    let buyer_before = balance(&env, env.buyer.id()).await?;
    ok(call0(&env.stranger, &c.account, "expire").await?)?;
    assert_eq!(state(&env, &c.account).await?, "returned");
    assert_eq!(balance(&env, env.buyer.id()).await?, buyer_before + 3 * USDC);

    // The reservation is back.
    let usage: Value = env.factory.view("usage").args_json(json!({ "payee": env.payee.id() })).await?.json()?;
    assert_eq!(usage["payee_used"], "0");
    let s: Value = env.factory.view("standing").args_json(json!({ "account_id": env.payee.id() })).await?.json()?;
    assert_eq!(s["as_payee"]["returned"], 1);

    // Delivery after return is impossible.
    let out = relay(&env, &c.account, &c.worker_sk, &c.account, submit_delivery("late"), &env.relayer).await?;
    assert!(!out.ok);

    // A late deposit after Returned is swept to the buyer.
    fund_plain(&env, &c.account, USDC).await?;
    let buyer_before = balance(&env, env.buyer.id()).await?;
    ok(call0(&env.stranger, &c.account, "sync_funding").await?)?;
    assert_eq!(balance(&env, &c.account).await?, 0);
    assert_eq!(balance(&env, env.buyer.id()).await?, buyer_before + USDC);
    assert_eq!(state(&env, &c.account).await?, "returned");

    // ft_transfer_call into a returned clause is refunded in full.
    let r = ok(fund_call(&env, &c.account, USDC).await?)?;
    let used: String = r.json()?;
    assert_eq!(used, "0");
    Ok(())
}

#[tokio::test]
async fn failed_ft_transfer_leaves_clause_retryable() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 0).await?.expect("create");
    ok(fund_call(&env, &c.account, 2 * USDC).await?)?;

    set_fail_transfers(&env, true).await?;
    let out = relay(&env, &c.account, &c.worker_sk, &c.account, submit_delivery("h"), &env.relayer).await?;
    assert!(!out.ok, "the payout receipt failed");
    let v = clause_view(&env, &c.account).await?;
    assert_eq!(v["state"], "delivered", "delivery recorded, payout not");
    assert_eq!(v["settling"], false, "lock released");
    assert_eq!(balance(&env, &c.account).await?, 2 * USDC);

    let r = call0(&env.stranger, &c.account, "release").await?;
    assert!(!fully_ok(&r), "still failing while the FT fails");
    assert_eq!(state(&env, &c.account).await?, "delivered");

    set_fail_transfers(&env, false).await?;
    ok(call0(&env.stranger, &c.account, "release").await?)?;
    assert_eq!(state(&env, &c.account).await?, "released");
    assert_eq!(balance(&env, env.payee.id()).await?, 2 * USDC);
    let receipts: Vec<Value> = env.factory.view("get_receipts").args_json(json!({})).await?.json()?;
    assert_eq!(receipts.len(), 1, "one receipt despite the failed attempts");
    Ok(())
}

#[tokio::test]
async fn freeze_then_cosign_returns_to_buyer() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 120).await?.expect("create");
    ok(fund_call(&env, &c.account, 2 * USDC).await?)?;
    let out = relay(&env, &c.account, &c.worker_sk, &c.account, submit_delivery("h"), &env.relayer).await?;
    assert!(out.ok, "{}", out.detail);

    let r = call0(&env.payee, &c.account, "freeze").await?;
    assert!(failure_text(&r).contains("ONLY_BUYER"));
    ok(call0(&env.buyer, &c.account, "freeze").await?)?;
    assert_eq!(state(&env, &c.account).await?, "frozen");

    advance_secs(&env, 125).await?;
    let r = call0(&env.stranger, &c.account, "release").await?;
    assert!(r.is_failure(), "release is blocked while frozen");

    let cosign = |who: &Account, d: &str| {
        who.call(&c.account, "cosign").args_json(json!({ "decision": d })).max_gas().transact()
    };
    assert!(cosign(&env.stranger, "release").await?.is_failure());
    ok(cosign(&env.buyer, "return").await?)?;
    assert_eq!(state(&env, &c.account).await?, "frozen", "one vote is not enough");
    let buyer_before = balance(&env, env.buyer.id()).await?;
    ok(cosign(&env.cosigner, "return").await?)?;
    assert_eq!(state(&env, &c.account).await?, "returned");
    assert_eq!(balance(&env, env.buyer.id()).await?, buyer_before + 2 * USDC);
    assert_eq!(balance(&env, env.payee.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn record_outcome_only_from_own_clause() -> Result<()> {
    let env = setup().await?;
    let c = create_clause(&env, env.payee.id(), USDC, 900, 0).await?.expect("create");
    let r = env
        .stranger
        .call(env.factory.id(), "record_outcome")
        .args_json(json!({ "id": 0, "outcome": "released", "paid": "1000000" }))
        .transact()
        .await?;
    assert!(failure_text(&r).contains("ONLY_OWN_CLAUSE"));
    let s: Value = env.factory.view("standing").args_json(json!({ "account_id": env.payee.id() })).await?.json()?;
    assert_eq!(s["as_payee"]["released"], 0);
    let _ = c;
    Ok(())
}

#[tokio::test]
async fn test_token_faucet_registers_and_caps() -> Result<()> {
    let env = setup().await?;
    // A fresh account that was never registered on the FT.
    let r = ok(call0(&env.stranger, env.ft.id(), "faucet").await?)?;
    let minted: String = r.json()?;
    assert_eq!(minted, "20000000");
    assert_eq!(balance(&env, env.stranger.id()).await?, 20 * USDC);
    // Calling again tops up to the cap only.
    let r = ok(call0(&env.stranger, env.ft.id(), "faucet").await?)?;
    let minted: String = r.json()?;
    assert_eq!(minted, "0");
    // The faucet balance funds a clause like any other.
    let c = create_clause(&env, env.payee.id(), 2 * USDC, 900, 0).await?.expect("create");
    ok(env
        .stranger
        .call(env.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": c.account, "amount": (2 * USDC).to_string(), "msg": "" }))
        .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)?;
    assert_eq!(state(&env, &c.account).await?, "funded");
    Ok(())
}
