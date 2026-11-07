import { currentNetwork, NETWORKS } from "./network";

/**
 * Talks to the Clausehold desk API (src/api/server.ts). Each network has its
 * own desk API, chosen by the network switch. Settings, including the agent
 * key, are kept per network and only in this browser.
 */

const settingsKey = () => `clausehold.settings.${currentNetwork()}`;

export interface DeskSettings {
  apiBase: string;
  apiKey: string;
  agentId: string;
  mandateId: string;
  buyer: string;
}

function defaults(): DeskSettings {
  const n = currentNetwork();
  return {
    apiBase: NETWORKS[n].apiBase,
    apiKey: "",
    agentId: "studio-agent",
    mandateId: "b2f1e9a0-1a2b-4c3d-8e4f-000000000001",
    buyer: n === "testnet" ? "studio-agent.testnet" : "",
  };
}

export function loadSettings(): DeskSettings {
  try {
    const raw = localStorage.getItem(settingsKey());
    return raw ? { ...defaults(), ...(JSON.parse(raw) as Partial<DeskSettings>) } : defaults();
  } catch {
    return defaults();
  }
}

export function saveSettings(s: DeskSettings): void {
  try {
    localStorage.setItem(settingsKey(), JSON.stringify(s));
  } catch {
    /* private mode: settings last for this page only */
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
  const s = loadSettings();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body) headers["Content-Type"] = "application/json";
  if (init.auth && s.apiKey) headers["X-Clausehold-Api-Key"] = s.apiKey;
  let res: Response;
  try {
    res = await fetch(`${s.apiBase.replace(/\/$/, "")}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, `Could not reach the desk API at ${s.apiBase}`);
  }
  const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText, body);
  return body as T;
}

export interface RuleResult {
  rule: string;
  outcome: "ok" | "violated" | "warning";
  detail: string;
}

export interface Verdict {
  decision: "PASS" | "VETO" | "ESCALATE";
  reasons: RuleResult[];
  amount: number;
  asset: string;
}

export interface ClauseProposal {
  id: string;
  buyer: string;
  payee: string;
  asset: string;
  amount: number;
  terms: string;
  deadline: string;
  challengeSecs: number;
  submittedAt: string;
}

export interface InviteView {
  inviteId: string;
  status: "awaiting_key" | "key_bound" | "written";
  cleared: boolean;
  terms: string;
  amount: number;
  asset: string;
  payee: string;
  buyer: string;
  deadline: string;
  challengeSecs: number;
  publicKey: string | null;
  keySource: "passkey-prf" | "browser-random" | null;
  clauseAccountId: string | null;
  createTxHash: string | null;
  /** The clause's last state seen on chain, e.g. CLAUSE_FUNDED. */
  chainStatus?: string | null;
}

export interface OpenInviteResult {
  proposalId: string;
  proposal: ClauseProposal;
  verdict: Verdict;
  cleared: boolean;
  approval: { approvalId: string; expiresAt: string } | null;
  invite: { inviteId: string; path: string } | null;
}

export interface MandateView {
  id: string;
  version: number;
  owner: string;
  factoryAccountId: string;
  naturalLanguageSource: string;
  status: string;
  limits: {
    maxPerClause: number;
    dailySpendCap: number;
    perPayeeDailyCap: number;
    newPayeeCeiling: number;
    confirmAbove: number;
    allowedAssets: string[];
    maxDeadlineMinutes?: number;
  };
}

export interface DeskClause {
  proposal: ClauseProposal;
  decision: Verdict["decision"];
  refusedBy: string[];
  inviteId: string | null;
  inviteStatus: InviteView["status"] | null;
  clauseAccountId: string | null;
  lastEvent: string;
}

export interface CreateCall {
  receiverId: string;
  methodName: "create_clause";
  args: { worker_pk: string; [k: string]: unknown };
  deposit: string;
  gas: string;
}

export const api = {
  createCall: (inviteId: string) => call<CreateCall>(`/invites/${encodeURIComponent(inviteId)}/create`),
  written: (inviteId: string, clauseAccountId: string, txHash: string) =>
    call<{ invite: InviteView }>(`/invites/${encodeURIComponent(inviteId)}/written`, { method: "POST", body: JSON.stringify({ clauseAccountId, txHash }) }),
  openInvite: (body: Record<string, unknown>) => call<OpenInviteResult>("/invites", { method: "POST", body: JSON.stringify(body), auth: true }),
  invite: (id: string) => call<InviteView>(`/invites/${encodeURIComponent(id)}`),
  bindKey: (id: string, publicKey: string, keySource: string) =>
    call<{ invite: InviteView; pendingReason: string | null }>(`/invites/${encodeURIComponent(id)}/key`, { method: "POST", body: JSON.stringify({ publicKey, keySource }) }),
  mandate: (id: string) => call<MandateView>(`/mandate?id=${encodeURIComponent(id)}`),
  clauses: () => call<DeskClause[]>("/desk/clauses", { auth: true }),
  fundQuote: (proposalId: string, body: { originAsset: string; refundTo: string; dry: boolean }) =>
    call<{ clauseAccountId: string; quote: { quote: { depositAddress?: string; amountInFormatted: string; amountOutFormatted: string; timeEstimate: number } } }>(
      `/clauses/${encodeURIComponent(proposalId)}/fund/quote`,
      { method: "POST", body: JSON.stringify(body) }
    ),
  relay: (signedDelegate: string) => call<{ txHash: string; senderId: string; status: string }>("/relay", { method: "POST", body: JSON.stringify({ signedDelegate }) }),
  prepareRelay: (clause: string, publicKey: string) =>
    call<{ nonce: string; maxBlockHeight: string }>(`/relay/prepare?clause=${encodeURIComponent(clause)}&publicKey=${encodeURIComponent(publicKey)}`),
  checkFunding: (proposalId: string) => call<{ txHash: string; status: string }>(`/clauses/${encodeURIComponent(proposalId)}/check-funding`, { method: "POST", auth: true }),
  returnToBuyer: (proposalId: string) => call<{ txHash: string; status: string }>(`/clauses/${encodeURIComponent(proposalId)}/return`, { method: "POST", auth: true }),
};

export function statusOf(c: DeskClause): "refused" | "awaiting" | "open" | "funded" | "delivered" | "released" | "returned" | "frozen" {
  if (c.decision === "VETO") return "refused";
  const e = c.lastEvent;
  if (e === "CLAUSE_RELEASED") return "released";
  if (e === "CLAUSE_RETURNED") return "returned";
  if (e === "CLAUSE_FROZEN") return "frozen";
  if (e === "CLAUSE_DELIVERED") return "delivered";
  if (e === "CLAUSE_FUNDED") return "funded";
  if (c.inviteStatus === "written") return "open";
  return "awaiting";
}
