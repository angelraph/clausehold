/**
 * What an AI agent (or a script) does with Clausehold, as plain functions.
 * The MCP server, the judge run and the e2e script all go through these, so
 * an agent hiring another agent takes exactly the path a person takes on the
 * website: the buyer's own key writes and funds the clause, the worker's own
 * key delivers, and the desk only relays the delivery and pays its gas.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { delegateSigningBytes, encodeDeliveryDelegate, encodeSignedDelegate, publicKeyBytes, toBase64 } from "../../web/src/lib/delegate.js";

export interface AgentEnv {
  network: "testnet" | "mainnet";
  /** The desk API that checks clauses and relays deliveries. */
  desk: string;
  rpc: string;
  factory: string;
  /** The stablecoin clauses are paid in. */
  token: string;
  /** Mandate the desk checks clauses against. */
  mandateId: string;
  /** Where a worker keeps the keys it made for jobs it accepted. */
  workerKeyDir: string;
}

export function agentEnv(): AgentEnv {
  const network = process.env.CLAUSEHOLD_NETWORK === "mainnet" ? "mainnet" : "testnet";
  return {
    network,
    desk: (process.env.CLAUSEHOLD_DESK_URL ?? (network === "mainnet" ? "https://clausehold-api-mainnet.vercel.app" : "https://clausehold-api-testnet.vercel.app")).replace(/\/$/, ""),
    rpc: process.env.CLAUSEHOLD_NEAR_RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org"),
    factory: process.env.CLAUSEHOLD_FACTORY_ACCOUNT ?? (network === "mainnet" ? "clausehold.near" : "clausehold.testnet"),
    token: process.env.CLAUSEHOLD_TOKEN ?? (network === "mainnet" ? "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" : "musd.clausehold.testnet"),
    mandateId: process.env.CLAUSEHOLD_MANDATE_ID ?? "b2f1e9a0-1a2b-4c3d-8e4f-000000000001",
    workerKeyDir: process.env.CLAUSEHOLD_WORKER_KEYS ?? join(homedir(), ".clausehold", "worker-keys"),
  };
}

const TGAS = 10n ** 12n;

export class AgentError extends Error {}

export function provider(env: AgentEnv = agentEnv()): JsonRpcProvider {
  return new JsonRpcProvider({ url: env.rpc });
}

/**
 * The agent's own NEAR account. Its key comes from the environment
 * (CLAUSEHOLD_AGENT_ACCOUNT and CLAUSEHOLD_AGENT_PRIVATE_KEY) or from the
 * near-cli keychain at ~/.near-credentials/<network>/<account>.json.
 */
export function agentAccount(accountId = process.env.CLAUSEHOLD_AGENT_ACCOUNT, env: AgentEnv = agentEnv()): Account {
  if (!accountId) throw new AgentError("Set CLAUSEHOLD_AGENT_ACCOUNT to the NEAR account this agent pays from");
  let key = accountId === process.env.CLAUSEHOLD_AGENT_ACCOUNT ? process.env.CLAUSEHOLD_AGENT_PRIVATE_KEY : undefined;
  if (!key) {
    const file = join(homedir(), ".near-credentials", env.network, `${accountId}.json`);
    if (!existsSync(file)) throw new AgentError(`No key for ${accountId}: set CLAUSEHOLD_AGENT_PRIVATE_KEY or add ${file}`);
    key = (JSON.parse(readFileSync(file, "utf8")) as { private_key: string }).private_key;
  }
  return new Account(accountId, provider(env), key as KeyPairString);
}

export async function desk<T>(path: string, init: RequestInit = {}, env: AgentEnv = agentEnv()): Promise<T> {
  const res = await fetch(`${env.desk}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new AgentError(body.error ?? `${init.method ?? "GET"} ${path} answered ${res.status}`);
  return body;
}

const view = <T>(env: AgentEnv, contractId: string, method: string, args: Record<string, unknown> = {}) =>
  provider(env).callFunction({ contractId, method, args }) as Promise<T>;

export const toBase6 = (amount: number) => BigInt(Math.round(amount * 1_000_000));
export const fromBase6 = (base: bigint | string) => Number(BigInt(base)) / 1e6;

// ------------------------------------------------------------------ hiring

export interface PayeeCheck {
  payee: string;
  released: number;
  returned: number;
  receivedTotal: number;
  /** Largest single clause this payee may be offered right now. */
  earnedLimit: number;
  why: string;
}

/** Reads the payee's record from the factory: what it has delivered, and what that unlocks. */
export async function checkPayee(payee: string, env: AgentEnv = agentEnv()): Promise<PayeeCheck> {
  type Stats = { released: number; returned: number; released_volume: string };
  const [s, m] = await Promise.all([
    view<{ as_payee: Stats }>(env, env.factory, "standing", { account_id: payee }),
    view<{ max_per_clause: string; new_payee_ceiling: string } | null>(env, env.factory, "get_mandate"),
  ]);
  const cap = m ? fromBase6(m.max_per_clause) : 0;
  const ceiling = m ? Math.min(fromBase6(m.new_payee_ceiling), cap) : 0;
  const lifted = s.as_payee.released > 0;
  return {
    payee,
    released: s.as_payee.released,
    returned: s.as_payee.returned,
    receivedTotal: fromBase6(s.as_payee.released_volume),
    earnedLimit: lifted ? cap : ceiling,
    why: lifted
      ? `${s.as_payee.released} released ${s.as_payee.released === 1 ? "clause" : "clauses"} on chain lift this payee to the full per-clause cap`
      : "no released clause yet, so the new-payee ceiling applies",
  };
}

export interface OpenedJob {
  proposalId: string;
  decision: "PASS" | "VETO" | "ESCALATE";
  reasons: Array<{ rule: string; outcome: string; detail: string }>;
  inviteId: string | null;
  /** Link to send the worker. */
  inviteUrl: string | null;
}

/** Proposes a job. The desk checks it against the mandate before anyone signs. */
export async function openJob(
  o: { buyer: string; payee: string; amount: number; terms: string; minutes?: number; reviewSeconds?: number; agentId?: string },
  env: AgentEnv = agentEnv()
): Promise<OpenedJob> {
  const r = await desk<{ proposal: { id: string }; verdict: { decision: OpenedJob["decision"]; reasons: OpenedJob["reasons"] }; invite: { inviteId: string; path: string } | null }>(
    "/invites",
    {
      method: "POST",
      body: JSON.stringify({
        agentId: o.agentId ?? "mcp-agent",
        mandateId: env.mandateId,
        buyer: o.buyer,
        payee: o.payee,
        asset: "USDC",
        amount: o.amount,
        terms: o.terms,
        deadlineMinutes: o.minutes ?? 30,
        challengeSecs: o.reviewSeconds ?? 0,
      }),
    },
    env
  );
  const site = process.env.CLAUSEHOLD_SITE_URL ?? "https://clausehold.vercel.app";
  return {
    proposalId: r.proposal.id,
    decision: r.verdict.decision,
    reasons: r.verdict.reasons,
    inviteId: r.invite?.inviteId ?? null,
    inviteUrl: r.invite ? `${site}${r.invite.path}` : null,
  };
}

// ------------------------------------------------------------------ worker

interface StoredKey {
  inviteId: string;
  secretKey: string;
  publicKey: string;
}

function keyFile(inviteId: string, env: AgentEnv) {
  return join(env.workerKeyDir, `${inviteId.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
}

function loadWorkerKey(inviteId: string, env: AgentEnv): StoredKey | null {
  const f = keyFile(inviteId, env);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as StoredKey) : null;
}

/**
 * Accepts a job as the worker: makes the one key the clause will accept and
 * binds it to the invite. The secret never leaves this machine.
 */
export async function acceptJob(inviteId: string, env: AgentEnv = agentEnv()): Promise<{ publicKey: string; status: string; note: string | null }> {
  let stored = loadWorkerKey(inviteId, env);
  if (!stored) {
    const pair = KeyPair.fromRandom("ed25519");
    stored = { inviteId, secretKey: pair.toString(), publicKey: pair.getPublicKey().toString() };
    mkdirSync(env.workerKeyDir, { recursive: true });
    writeFileSync(keyFile(inviteId, env), JSON.stringify(stored), { mode: 0o600 });
  }
  const r = await desk<{ invite: { status: string }; pendingReason: string | null }>(
    `/invites/${encodeURIComponent(inviteId)}/key`,
    { method: "POST", body: JSON.stringify({ publicKey: stored.publicKey, keySource: "browser-random" }) },
    env
  );
  return { publicKey: stored.publicKey, status: r.invite.status, note: r.pendingReason };
}

/** Finds the clause the factory made for a worker key, among its recent clauses. */
async function clauseForKey(env: AgentEnv, workerPk: string): Promise<string | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const count = await view<number>(env, env.factory, "clause_count");
    const recent = await view<Array<{ account_id: string; worker_pk: string }>>(env, env.factory, "get_clauses", { from_index: Math.max(0, count - 50), limit: 50 });
    const hit = recent.find((c) => c.worker_pk === workerPk);
    if (hit) return hit.account_id;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

// ------------------------------------------------------------------- buyer

export interface FundedJob {
  clause: string;
  createTx: string;
  fundTx: string;
  storageDepositNear: number;
}

/**
 * The buyer's own key writes the clause (paying its storage deposit, which
 * comes back on close) and funds it with exactly the clause amount.
 */
export async function writeAndFund(buyer: Account, inviteId: string, env: AgentEnv = agentEnv()): Promise<FundedJob> {
  const inv = await desk<{ status: string; amount: number; buyer: string; clauseAccountId: string | null }>(`/invites/${encodeURIComponent(inviteId)}`, {}, env);
  if (inv.buyer !== buyer.accountId) throw new AgentError(`This job is paid by ${inv.buyer}, not ${buyer.accountId}`);
  if (inv.status === "awaiting_key") throw new AgentError("The worker has not accepted yet");
  let clause = inv.clauseAccountId;
  let createTx = "";
  let deposit = 0n;
  if (!clause) {
    const call = await desk<{ receiverId: string; methodName: string; args: { worker_pk: string } & Record<string, unknown>; deposit: string; gas: string }>(
      `/invites/${encodeURIComponent(inviteId)}/create`,
      {},
      env
    );
    deposit = BigInt(call.deposit);
    const sent = await buyer.callFunctionRaw({ contractId: call.receiverId, methodName: call.methodName, args: call.args, deposit, gas: BigInt(call.gas) });
    createTx = sent.transaction.hash;
    clause = await clauseForKey(env, call.args.worker_pk);
    if (!clause) throw new AgentError(`The factory did not create the clause (tx ${createTx}); the deposit was refunded`);
    await desk(`/invites/${encodeURIComponent(inviteId)}/written`, { method: "POST", body: JSON.stringify({ clauseAccountId: clause, txHash: createTx }) }, env);
  }
  const amount = toBase6(inv.amount);
  const held = BigInt((await view<string>(env, env.token, "ft_balance_of", { account_id: buyer.accountId })) ?? "0");
  if (held < amount && env.network === "testnet") {
    await buyer.callFunction({ contractId: env.token, methodName: "faucet", args: {}, gas: 30n * TGAS });
  }
  const funded = await buyer.callFunctionRaw({
    contractId: env.token,
    methodName: "ft_transfer_call",
    args: { receiver_id: clause, amount: amount.toString(), msg: "" },
    gas: 150n * TGAS,
    deposit: 1n,
  });
  return { clause, createTx, fundTx: funded.transaction.hash, storageDepositNear: Number(deposit / 10n ** 20n) / 1e4 };
}

// ---------------------------------------------------------------- delivery

/**
 * The worker delivers. Its key signs a NEP-366 delegate for submit_delivery;
 * the desk relays it and pays the gas. With no review window the clause pays
 * the worker in the same transaction.
 */
export async function deliver(inviteId: string, work: string, env: AgentEnv = agentEnv()): Promise<{ clause: string; hash: string; txHash: string; status: string }> {
  const stored = loadWorkerKey(inviteId, env);
  if (!stored) throw new AgentError("No key for this job on this machine. Accept it here first.");
  const inv = await desk<{ clauseAccountId: string | null; status: string }>(`/invites/${encodeURIComponent(inviteId)}`, {}, env);
  if (!inv.clauseAccountId) throw new AgentError("The buyer has not written the clause yet");
  const clause = inv.clauseAccountId;
  const state = await view<string>(env, clause, "get_state");
  if (state !== "funded") throw new AgentError(`The clause is ${state}; it can be delivered only while funded`);
  const pair = KeyPair.fromString(stored.secretKey as KeyPairString);
  const prep = await desk<{ nonce: string; maxBlockHeight: string }>(`/relay/prepare?clause=${encodeURIComponent(clause)}&publicKey=${encodeURIComponent(stored.publicKey)}`, {}, env);
  const hash = `sha256:${createHash("sha256").update(work).digest("hex")}`;
  const delegate = encodeDeliveryDelegate({
    clauseAccountId: clause,
    publicKey: publicKeyBytes(stored.publicKey),
    nonce: BigInt(prep.nonce),
    maxBlockHeight: BigInt(prep.maxBlockHeight),
    hash,
  });
  const digest = createHash("sha256").update(delegateSigningBytes(delegate)).digest();
  const { signature } = pair.sign(new Uint8Array(digest));
  const relayed = await desk<{ txHash: string; status: string }>(
    "/relay",
    { method: "POST", body: JSON.stringify({ signedDelegate: toBase64(encodeSignedDelegate(delegate, signature)) }) },
    env
  );
  return { clause, hash, txHash: relayed.txHash, status: relayed.status };
}

// ------------------------------------------------------------------ status

export interface JobStatus {
  inviteId: string;
  inviteStatus: string;
  buyer: string;
  payee: string;
  amount: number;
  deadline: string;
  clause: string | null;
  /** open, funded, delivered, frozen, released, returned, closed, or not_written */
  state: string;
  closable: boolean;
  explorer: string | null;
}

export async function jobStatus(inviteId: string, env: AgentEnv = agentEnv()): Promise<JobStatus> {
  const inv = await desk<{ status: string; buyer: string; payee: string; amount: number; deadline: string; clauseAccountId: string | null }>(`/invites/${encodeURIComponent(inviteId)}`, {}, env);
  let state = "not_written";
  let closable = false;
  if (inv.clauseAccountId) {
    try {
      const c = await view<{ state: string; reported?: boolean; settling: boolean }>(env, inv.clauseAccountId, "get_clause");
      state = c.state;
      closable = (c.state === "released" || c.state === "returned") && c.reported === true && !c.settling;
    } catch {
      state = "closed";
    }
  }
  const explorer = inv.clauseAccountId ? `https://${env.network === "testnet" ? "testnet." : ""}nearblocks.io/address/${inv.clauseAccountId}` : null;
  return { inviteId, inviteStatus: inv.status, buyer: inv.buyer, payee: inv.payee, amount: inv.amount, deadline: inv.deadline, clause: inv.clauseAccountId, state, closable, explorer };
}

/** Closes a settled clause. The account deletes itself and its storage NEAR goes back to the buyer. */
export async function closeJob(signer: Account, clause: string, env: AgentEnv = agentEnv()): Promise<{ txHash: string; closed: boolean }> {
  const r = await signer.callFunctionRaw({ contractId: clause, methodName: "close", args: {}, gas: 100n * TGAS });
  const closed = await provider(env).viewAccount({ accountId: clause }).then(() => false).catch(() => true);
  return { txHash: r.transaction.hash, closed };
}
