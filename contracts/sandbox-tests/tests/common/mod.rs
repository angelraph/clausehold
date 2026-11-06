//! Shared sandbox setup: a factory, a mock NEP-141, and named accounts.
#![allow(dead_code)]

pub mod relay;

use anyhow::{anyhow, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const USDC: u128 = 1_000_000;
pub const SEC: u64 = 1_000_000_000;

pub fn wasm(name: &str) -> Vec<u8> {
    let dir = std::env::var("CLAUSEHOLD_WASM_DIR")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("CARGO_TARGET_DIR").map(|t| PathBuf::from(t).join("near")))
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/near"));
    let path = dir.join(name).join(format!("{}.wasm", name.replace('-', "_")));
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing {}: {e}. Build the contracts first (see contracts/README.md).",
            path.display()
        )
    })
}

pub struct Env {
    pub worker: Worker<Sandbox>,
    pub factory: Contract,
    pub ft: Contract,
    pub dao: Account,
    pub desk: Account,
    pub buyer: Account,
    pub payee: Account,
    pub relayer: Account,
    pub cosigner: Account,
    pub stranger: Account,
}

pub fn mandate(ft: &AccountId, cosigner: &AccountId) -> Value {
    json!({
        "allowed_assets": [ft],
        "max_per_clause": (5 * USDC).to_string(),
        "per_payee_daily_cap": (6 * USDC).to_string(),
        "daily_cap": (20 * USDC).to_string(),
        "new_payee_ceiling": (6 * USDC).to_string(),
        "paused": false,
        "cosigner": cosigner,
        "creators": [],
    })
}

pub async fn setup() -> Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;

    let mk = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .map_err(|e| anyhow!("create {name}: {e:?}"))
        }
    };

    let factory_acc = mk("clausehold", 60).await?;
    let ft_acc = mk("usdc", 20).await?;
    let dao = mk("dao", 20).await?;
    let desk = mk("desk", 60).await?;
    let buyer = mk("buyer", 20).await?;
    let payee = mk("payee", 20).await?;
    let relayer = mk("relayer", 20).await?;
    let cosigner = mk("cosigner", 20).await?;
    let stranger = mk("stranger", 20).await?;

    let ft = ft_acc.deploy(&wasm("mock-ft")).await?.into_result()?;
    ok(ft.call("new").transact().await?)?;
    ok(ft
        .call("mint")
        .args_json(json!({ "account_id": buyer.id(), "amount": (100 * USDC).to_string() }))
        .transact()
        .await?)?;

    let factory = factory_acc.deploy(&wasm("factory")).await?.into_result()?;
    ok(factory
        .call("new")
        .args_json(json!({ "owner": dao.id(), "mandate": mandate(ft.id(), cosigner.id()) }))
        .transact()
        .await?)?;
    ok(dao
        .call(factory.id(), "set_clause_code")
        .args(wasm("clause"))
        .max_gas()
        .transact()
        .await?)?;

    Ok(Env { worker, factory, ft, dao, desk, buyer, payee, relayer, cosigner, stranger })
}

pub fn ok(r: ExecutionFinalResult) -> Result<ExecutionFinalResult> {
    if r.is_success() && r.receipt_failures().is_empty() {
        Ok(r)
    } else {
        Err(anyhow!("transaction failed: {:#?}", r.failures()))
    }
}

/// The whole transaction succeeded at the top level and every receipt too.
pub fn fully_ok(r: &ExecutionFinalResult) -> bool {
    r.is_success() && r.receipt_failures().is_empty()
}

pub fn failure_text(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

pub struct Created {
    pub account: AccountId,
    pub worker_sk: SecretKey,
}

pub async fn now_secs(env: &Env) -> Result<u64> {
    Ok(env.worker.view_block().await?.timestamp() / SEC)
}

pub async fn create_clause(
    env: &Env,
    payee: &AccountId,
    amount: u128,
    deadline_in: u64,
    challenge_secs: u64,
) -> Result<std::result::Result<Created, String>> {
    let worker_sk = SecretKey::from_random(KeyType::ED25519);
    let deposit: String = env.factory.view("create_deposit").await?.json()?;
    let deadline = now_secs(env).await? + deadline_in;
    let r = env
        .desk
        .call(env.factory.id(), "create_clause")
        .args_json(json!({
            "buyer": env.buyer.id(),
            "payee": payee,
            "worker_pk": worker_sk.public_key(),
            "asset": env.ft.id(),
            "amount": amount.to_string(),
            "deadline": deadline,
            "terms_hash": "sha256:terms",
            "challenge_secs": challenge_secs,
        }))
        .deposit(NearToken::from_yoctonear(deposit.parse()?))
        .max_gas()
        .transact()
        .await?;
    if !fully_ok(&r) {
        return Ok(Err(failure_text(&r)));
    }
    let account: Option<AccountId> = r.json()?;
    let account = account.ok_or_else(|| anyhow!("create returned null"))?;
    Ok(Ok(Created { account, worker_sk }))
}

pub async fn clause_view(env: &Env, clause: &AccountId) -> Result<Value> {
    Ok(env.worker.view(clause, "get_clause").await?.json()?)
}

pub async fn state(env: &Env, clause: &AccountId) -> Result<String> {
    Ok(clause_view(env, clause).await?["state"].as_str().unwrap().to_string())
}

pub async fn balance(env: &Env, who: &AccountId) -> Result<u128> {
    let v: String = env
        .ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": who }))
        .await?
        .json()?;
    Ok(v.parse()?)
}

/// Fund with ft_transfer_call (the clause's ft_on_transfer runs).
pub async fn fund_call(env: &Env, clause: &AccountId, amount: u128) -> Result<ExecutionFinalResult> {
    Ok(env
        .buyer
        .call(env.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": clause, "amount": amount.to_string(), "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?)
}

/// Fund with a plain ft_transfer, the way a 1Click delivery lands.
pub async fn fund_plain(env: &Env, clause: &AccountId, amount: u128) -> Result<()> {
    ok(env
        .buyer
        .call(env.ft.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": clause, "amount": amount.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?)?;
    Ok(())
}

pub async fn call0(who: &Account, contract: &AccountId, method: &str) -> Result<ExecutionFinalResult> {
    Ok(who.call(contract, method).args_json(json!({})).max_gas().transact().await?)
}

pub async fn set_fail_transfers(env: &Env, fail: bool) -> Result<()> {
    ok(env
        .ft
        .call("set_fail_transfers")
        .args_json(json!({ "fail": fail }))
        .transact()
        .await?)?;
    Ok(())
}

/// Advance the chain until block time is at least `secs` later.
pub async fn advance_secs(env: &Env, secs: u64) -> Result<()> {
    let target = env.worker.view_block().await?.timestamp() + secs * SEC;
    for _ in 0..50 {
        env.worker.fast_forward(200).await?;
        if env.worker.view_block().await?.timestamp() >= target {
            return Ok(());
        }
    }
    Err(anyhow!("could not advance block time by {secs}s"))
}
