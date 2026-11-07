//! Shared sandbox setup: a factory, a mock NEP-141, and named accounts.
#![allow(dead_code)]

pub mod relay;

use anyhow::{anyhow, Result};
use near_workspaces::network::{Sandbox, Testnet};
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

/// Where the tests run. `CLAUSEHOLD_NETWORK=testnet` uses the public NEAR
/// testnet (faucet-funded dev accounts, no Linux needed, real waits instead of
/// fast-forward). Anything else uses a local sandbox.
pub enum Net {
    Sandbox(Worker<Sandbox>),
    Testnet(Worker<Testnet>),
}

macro_rules! with_worker {
    ($net:expr, |$w:ident| $body:expr) => {
        match $net {
            Net::Sandbox($w) => $body,
            Net::Testnet($w) => $body,
        }
    };
}

/// rpc.testnet.near.org rate-limits hard; FastNEAR's public endpoint copes
/// with a test run. Override with CLAUSEHOLD_TESTNET_RPC.
pub fn testnet_rpc() -> String {
    std::env::var("CLAUSEHOLD_TESTNET_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into())
}

pub fn on_testnet() -> bool {
    std::env::var("CLAUSEHOLD_NETWORK").map(|v| v == "testnet").unwrap_or(false)
}

pub struct Env {
    pub net: Net,
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

async fn sub(parent: &Account, name: &str, near: NearToken) -> Result<Account> {
    parent
        .create_subaccount(name)
        .initial_balance(near)
        .transact()
        .await?
        .into_result()
        .map_err(|e| anyhow!("create {name}: {e:?}"))
}

pub async fn setup() -> Result<Env> {
    // `bank` funds the helper accounts; `desk` keeps its NEAR for clause
    // deposits. On testnet a max-gas tx reserves ~1 NEAR up front, so helpers
    // get 1.5 NEAR and the DAO (which uploads the 180 KB clause wasm) 2 NEAR.
    let (net, factory_acc, ft_acc, desk, bank, small, dao_near) = if on_testnet() {
        let w = near_workspaces::testnet().rpc_addr(&testnet_rpc()).await?;
        let factory_acc = w.dev_create_account().await?;
        let ft_acc = w.dev_create_account().await?;
        let desk = w.dev_create_account().await?;
        let bank = w.dev_create_account().await?;
        (Net::Testnet(w), factory_acc, ft_acc, desk, bank, NearToken::from_millinear(1_400), NearToken::from_near(2))
    } else {
        let w = near_workspaces::sandbox().await?;
        let root = w.root_account()?;
        let factory_acc = sub(&root, "clausehold", NearToken::from_near(60)).await?;
        let ft_acc = sub(&root, "usdc", NearToken::from_near(20)).await?;
        let desk = sub(&root, "desk", NearToken::from_near(60)).await?;
        let bank = sub(&root, "bank", NearToken::from_near(200)).await?;
        (Net::Sandbox(w), factory_acc, ft_acc, desk, bank, NearToken::from_near(20), NearToken::from_near(20))
    };
    let dao = sub(&bank, "dao", dao_near).await?;
    let buyer = sub(&bank, "buyer", small).await?;
    let payee = sub(&bank, "payee", small).await?;
    let relayer = sub(&bank, "relayer", small).await?;
    let cosigner = sub(&bank, "cosigner", small).await?;
    let stranger = sub(&bank, "stranger", small).await?;

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

    Ok(Env { net, factory, ft, dao, desk, buyer, payee, relayer, cosigner, stranger })
}

impl Env {
    pub fn rpc_addr(&self) -> String {
        match &self.net {
            Net::Sandbox(w) => w.rpc_addr(),
            Net::Testnet(_) => testnet_rpc(),
        }
    }

    /// (height, hash bytes, timestamp ns) of the latest block.
    pub async fn block(&self) -> Result<(u64, [u8; 32], u64)> {
        let b = with_worker!(&self.net, |w| w.view_block().await?);
        Ok((b.height(), b.hash().0, b.timestamp()))
    }

    pub async fn view_json(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        Ok(with_worker!(&self.net, |w| w.view(contract, method).args_json(args).await?.json()?))
    }

    pub async fn access_keys(&self, id: &AccountId) -> Result<Vec<near_workspaces::types::AccessKeyInfo>> {
        Ok(with_worker!(&self.net, |w| w.view_access_keys(id).await?))
    }

    /// An account that signs with `sk` (e.g. the clause's worker FC key).
    pub fn account_with_key(&self, id: AccountId, sk: SecretKey) -> Account {
        with_worker!(&self.net, |w| Account::from_secret_key(id, sk, w))
    }
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
    Ok(env.block().await?.2 / SEC)
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
    env.view_json(clause, "get_clause", json!({})).await
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

/// Advance the chain until block time is at least `secs` later. Sandbox
/// fast-forwards; testnet just waits.
pub async fn advance_secs(env: &Env, secs: u64) -> Result<()> {
    let target = env.block().await?.2 + secs * SEC;
    for _ in 0..120 {
        match &env.net {
            Net::Sandbox(w) => w.fast_forward(200).await?,
            Net::Testnet(_) => tokio::time::sleep(std::time::Duration::from_secs(5)).await,
        }
        if env.block().await?.2 >= target {
            return Ok(());
        }
    }
    Err(anyhow!("could not advance block time by {secs}s"))
}
