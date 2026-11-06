//! NEP-366 meta-transactions, built by hand with near-primitives.
//! The worker signs a DelegateAction with its function-call key. A relayer
//! wraps it in a transaction it signs and pays for.

use anyhow::{anyhow, Result};
use near_crypto::{SecretKey as CSecretKey, Signer};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
use near_primitives::hash::CryptoHash;
use near_primitives::transaction::{
    Action, FunctionCallAction, SignedTransaction, Transaction, TransactionV0, TransferAction,
};
use near_primitives::types::{AccountId as PAccountId, BlockReference, Finality};
use near_primitives::views::{
    FinalExecutionOutcomeViewEnum, FinalExecutionStatus, QueryRequest, TxExecutionStatus,
};
use near_workspaces::types::SecretKey;
use near_workspaces::Account;

use super::Env;

fn pid(s: &str) -> PAccountId {
    s.parse().unwrap()
}

fn csk(sk: &SecretKey) -> CSecretKey {
    sk.to_string().parse().unwrap()
}

/// What the worker's page signs.
pub enum Inner {
    Call { method: String, args: serde_json::Value },
    Transfer { yocto: u128 },
}

pub fn submit_delivery(hash: &str) -> Inner {
    Inner::Call {
        method: "submit_delivery".into(),
        args: serde_json::json!({ "hash": hash, "note_hash": "note" }),
    }
}

pub struct RelayOutcome {
    /// Top-level status and every receipt succeeded.
    pub ok: bool,
    pub detail: String,
}

async fn access_key_nonce(client: &JsonRpcClient, account: &PAccountId, pk: &near_crypto::PublicKey) -> Result<u64> {
    let resp = client
        .call(methods::query::RpcQueryRequest {
            block_reference: BlockReference::Finality(Finality::Final),
            request: QueryRequest::ViewAccessKey { account_id: account.clone(), public_key: pk.clone() },
        })
        .await?;
    match resp.kind {
        near_jsonrpc_primitives::types::query::QueryResponseKind::AccessKey(ak) => Ok(ak.nonce),
        other => Err(anyhow!("unexpected query response {other:?}")),
    }
}

/// `worker_sk` signs a delegate for `inner` on `sender` (the clause
/// account), and `relayer` submits it. Returns the execution outcome.
pub async fn relay(
    env: &Env,
    sender: &near_workspaces::AccountId,
    worker_sk: &SecretKey,
    receiver: &near_workspaces::AccountId,
    inner: Inner,
    relayer: &Account,
) -> Result<RelayOutcome> {
    let client = JsonRpcClient::connect(env.rpc_addr());
    let sender_id = pid(sender.as_str());
    let worker_signer: Signer = near_crypto::InMemorySigner::from_secret_key(sender_id.clone(), csk(worker_sk));
    let relayer_id = pid(relayer.id().as_str());
    let relayer_signer: Signer =
        near_crypto::InMemorySigner::from_secret_key(relayer_id.clone(), csk(relayer.secret_key()));

    let (height, hash, _) = env.block().await?;
    let block_hash = CryptoHash(hash);

    let action = match inner {
        Inner::Call { method, args } => Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: method,
            args: serde_json::to_vec(&args)?,
            gas: near_primitives::gas::Gas::from_teragas(250),
            deposit: near_primitives::types::Balance::from_yoctonear(0),
        })),
        Inner::Transfer { yocto } => Action::Transfer(TransferAction {
            deposit: near_primitives::types::Balance::from_yoctonear(yocto),
        }),
    };

    let worker_pk = worker_signer.public_key();
    let nonce = access_key_nonce(&client, &sender_id, &worker_pk).await? + 1;
    let delegate = DelegateAction {
        sender_id: sender_id.clone(),
        receiver_id: pid(receiver.as_str()),
        actions: vec![NonDelegateAction::try_from(action).map_err(|_| anyhow!("nested delegate"))?],
        nonce,
        max_block_height: height + 1_000,
        public_key: worker_pk,
    };
    let signed = SignedDelegateAction::sign(&worker_signer, delegate);

    let relayer_nonce = access_key_nonce(&client, &relayer_id, &relayer_signer.public_key()).await? + 1;
    let tx = Transaction::V0(TransactionV0 {
        signer_id: relayer_id,
        public_key: relayer_signer.public_key(),
        nonce: relayer_nonce,
        receiver_id: sender_id,
        block_hash,
        actions: vec![Action::Delegate(Box::new(signed))],
    });
    let signature = relayer_signer.sign(tx.get_hash_and_size().0.as_ref());
    let signed_tx = SignedTransaction::new(signature, tx);

    let resp = client
        .call(methods::send_tx::RpcSendTransactionRequest {
            signed_transaction: signed_tx,
            wait_until: TxExecutionStatus::Final,
        })
        .await;
    let resp = match resp {
        Ok(r) => r,
        // An invalid transaction (bad key permission at the delegate layer
        // is reported in receipts, but a rejected tx lands here).
        Err(e) => return Ok(RelayOutcome { ok: false, detail: format!("{e:?}") }),
    };
    let outcome = match resp.final_execution_outcome {
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcome(o)) => o,
        Some(FinalExecutionOutcomeViewEnum::FinalExecutionOutcomeWithReceipt(o)) => o.final_outcome,
        None => return Err(anyhow!("no outcome")),
    };
    let top_ok = matches!(outcome.status, FinalExecutionStatus::SuccessValue(_));
    let receipt_failures: Vec<String> = outcome
        .receipts_outcome
        .iter()
        .filter(|r| matches!(r.outcome.status, near_primitives::views::ExecutionStatusView::Failure(_)))
        .map(|r| format!("{:?}", r.outcome.status))
        .collect();
    Ok(RelayOutcome {
        ok: top_ok && receipt_failures.is_empty(),
        detail: format!("status={:?} receipt_failures={receipt_failures:?}", outcome.status),
    })
}
