import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { KeyPair } from "near-api-js";

const cfg = vi.hoisted(() => ({
  apiKey: "agent-key" as string | undefined,
  approverKey: "approver-key" as string | undefined,
  requireAgentKeys: false,
  apiPort: 0,
  approvalTtlMinutes: 10,
  mandatesDir: "unused",
  network: "testnet" as "testnet" | "mainnet",
  factoryAccountId: "clausehold.testnet",
  nearRpcUrl: undefined as string | undefined,
  webOrigins: [] as string[],
}));

const store = vi.hoisted(() => ({
  entries: [] as Array<{ seq: number; timestamp: string; type: string; network: string; payload: unknown; prevHash: string; hash: string }>,
}));

vi.mock("../src/config.js", () => ({ config: cfg }));
vi.mock("../src/audit/log.js", () => ({
  auditLog: {
    tail: vi.fn(async () => []),
    append: vi.fn(async (type: string, network: string, payload: unknown) => {
      const e = { seq: store.entries.length, timestamp: new Date().toISOString(), type, network, payload, prevHash: "x", hash: "y" };
      store.entries.push(e);
      return e;
    }),
    all: vi.fn(async () => [...store.entries]),
    verify: vi.fn(async () => ({ ok: true })),
  },
}));
vi.mock("../src/policy/runClause.js", () => ({ runClause: vi.fn() }));

import { createApp, type ApiDeps } from "../src/api/server.js";
import { runClause } from "../src/policy/runClause.js";
import { RelayRefusedError } from "../src/near/relayer.js";
import type { OneClickClient } from "../src/near/intents.js";

const AGENT = { "X-Clausehold-Api-Key": "agent-key" };
const json = { "Content-Type": "application/json" };
const mandateId = "00000000-0000-0000-0000-000000000001";
const fields = { buyer: "studio.testnet", payee: "editor.testnet", asset: "USDC", amount: 2, terms: "Cut intro to 30s", deadlineMinutes: 15 };

let server: Server;
let base: string;

async function start(deps: ApiDeps) {
  server = createApp(deps).listen(0);
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => server?.close());

beforeEach(() => {
  store.entries.length = 0;
  vi.mocked(runClause).mockReset();
});

function proposal(amount = 2) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    agentId: "studio-agent",
    mandateId,
    buyer: "studio.testnet",
    payee: "editor.testnet",
    asset: "USDC",
    amount,
    terms: "Cut intro to 30s",
    deadline: new Date(Date.now() + 15 * 60_000).toISOString(),
    challengeSecs: 0,
    submittedAt: new Date().toISOString(),
  };
}

function mockDecision(decision: "PASS" | "VETO" | "ESCALATE", amount = 2) {
  const p = proposal(amount);
  vi.mocked(runClause).mockImplementation(async () => {
    if (decision === "PASS") store.entries.push({ seq: store.entries.length, timestamp: new Date().toISOString(), type: "CLAUSE_CLEARED", network: "testnet", payload: { proposal: p }, prevHash: "x", hash: "y" });
    return { proposal: p, verdict: { decision, reasons: [] }, cleared: decision === "PASS", approval: decision === "ESCALATE" ? { approvalId: "ap1", expiresAt: "later" } : undefined } as never;
  });
  return p;
}

const writer = { createClause: vi.fn(async () => ({ clauseAccountId: "r-104.clausehold.testnet", txHash: "TXC" })) };

async function openAndBind(): Promise<{ inviteId: string; proposalId: string }> {
  const p = mockDecision("PASS");
  const res = await fetch(`${base}/invites`, { method: "POST", headers: { ...json, ...AGENT }, body: JSON.stringify({ agentId: "studio-agent", mandateId, ...fields }) });
  const { invite } = (await res.json()) as { invite: { inviteId: string } };
  const key = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  await fetch(`${base}/invites/${invite.inviteId}/key`, { method: "POST", headers: json, body: JSON.stringify({ publicKey: key, keySource: "passkey-prf" }) });
  return { inviteId: invite.inviteId, proposalId: p.id };
}

describe("POST /invites", () => {
  it("needs the agent key", async () => {
    await start({});
    const res = await fetch(`${base}/invites`, { method: "POST", headers: json, body: JSON.stringify({ agentId: "a", mandateId, ...fields }) });
    expect(res.status).toBe(401);
  });

  it("opens an invite for a cleared clause and returns the editor's link", async () => {
    await start({});
    mockDecision("PASS");
    const res = await fetch(`${base}/invites`, { method: "POST", headers: { ...json, ...AGENT }, body: JSON.stringify({ agentId: "a", mandateId, ...fields }) });
    const body = (await res.json()) as { invite: { inviteId: string; path: string } };
    expect(res.status).toBe(200);
    expect(body.invite.path).toBe(`/w/${body.invite.inviteId}`);
  });

  it("opens no invite for a refused clause", async () => {
    await start({});
    mockDecision("VETO");
    const res = await fetch(`${base}/invites`, { method: "POST", headers: { ...json, ...AGENT }, body: JSON.stringify({ agentId: "a", mandateId, ...fields }) });
    expect(((await res.json()) as { invite: unknown }).invite).toBeNull();
    expect(store.entries.some((e) => e.type === "INVITE_OPENED")).toBe(false);
  });
});

describe("the editor's routes are public, and only those", () => {
  it("reads an invite and binds a key without any credential, then writes the clause", async () => {
    await start({ writer });
    const { inviteId } = await openAndBind();
    const res = await fetch(`${base}/invites/${inviteId}`);
    const body = (await res.json()) as { status: string; clauseAccountId: string };
    expect(res.status).toBe(200);
    expect(body.status).toBe("written");
    expect(body.clauseAccountId).toBe("r-104.clausehold.testnet");
  });

  it("an unknown invite is a 404 and a second key is a 409", async () => {
    await start({ writer });
    expect((await fetch(`${base}/invites/nope`)).status).toBe(404);
    const { inviteId } = await openAndBind();
    const again = await fetch(`${base}/invites/${inviteId}/key`, { method: "POST", headers: json, body: JSON.stringify({ publicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(), keySource: "browser-random" }) });
    expect(again.status).toBe(409);
  });

  it("says why a bound clause is not written yet when no writer is configured", async () => {
    await start({});
    mockDecision("PASS");
    const open = await fetch(`${base}/invites`, { method: "POST", headers: { ...json, ...AGENT }, body: JSON.stringify({ agentId: "a", mandateId, ...fields }) });
    const { invite } = (await open.json()) as { invite: { inviteId: string } };
    const res = await fetch(`${base}/invites/${invite.inviteId}/key`, { method: "POST", headers: json, body: JSON.stringify({ publicKey: KeyPair.fromRandom("ed25519").getPublicKey().toString(), keySource: "passkey-prf" }) });
    expect(((await res.json()) as { pendingReason: string }).pendingReason).toMatch(/no chain writer/);
  });

  it("other routes still need a key", async () => {
    await start({});
    expect((await fetch(`${base}/clauses/x`)).status).toBe(401);
    expect((await fetch(`${base}/audit/tail`)).status).toBe(401);
  });
});

describe("GET /network", () => {
  it("is public and says which network this desk serves", async () => {
    await start({});
    const res = await fetch(`${base}/network`);
    const body = (await res.json()) as { networkId: string; factoryAccountId: string; intents: boolean; funding: string; assets: Array<{ contractId: string }> };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ networkId: "testnet", factoryAccountId: "clausehold.testnet", intents: false, funding: "direct-transfer" });
    expect(body.assets[0]!.contractId).toBe("musd.clausehold.testnet");
  });
});

describe("funding on testnet", () => {
  it("explains direct transfer instead of quoting Intents, which is mainnet only", async () => {
    await start({ writer });
    const { proposalId } = await openAndBind();
    const res = await fetch(`${base}/clauses/${proposalId}/fund/quote`, { method: "POST", headers: json, body: JSON.stringify({ originAsset: "nep141:base-usdc", refundTo: "0x1" }) });
    const body = (await res.json()) as { error: string; funding: string };
    expect(res.status).toBe(409);
    expect(body.funding).toBe("direct-transfer");
    expect(body.error).toContain("musd.clausehold.testnet");
    expect(body.error).toContain("r-104.clausehold.testnet");
  });
});

describe("POST /clauses/:id/fund/quote", () => {
  beforeEach(() => {
    cfg.network = "mainnet";
  });
  afterEach(() => {
    cfg.network = "testnet";
  });

  const tokens = [{ assetId: "nep141:usdc.fake.near", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, priceUpdatedAt: "" }];

  function oneClick(amountOut = "2000000"): OneClickClient {
    return {
      tokens: vi.fn(async () => tokens),
      quote: vi.fn(async (req: { recipient: string; recipientType: string; amount: string }) => ({
        correlationId: "c",
        timestamp: "",
        signature: "",
        quoteRequest: req,
        quote: { depositAddress: "0xdep", amountIn: "2010000", amountOut, minAmountOut: amountOut, amountInFormatted: "", amountInUsd: "", minAmountIn: "", amountOutFormatted: "", amountOutUsd: "", timeEstimate: 10 },
      })),
      status: vi.fn(async () => ({ status: "PROCESSING" })),
    } as unknown as OneClickClient;
  }

  it("is 503 when Intents is not configured", async () => {
    await start({});
    const res = await fetch(`${base}/clauses/x/fund/quote`, { method: "POST", headers: json, body: JSON.stringify({ originAsset: "nep141:base-usdc", refundTo: "0x1" }) });
    expect(res.status).toBe(503);
  });

  it("refuses to quote a clause that is not on chain yet", async () => {
    await start({ oneClick: oneClick() });
    const res = await fetch(`${base}/clauses/unknown/fund/quote`, { method: "POST", headers: json, body: JSON.stringify({ originAsset: "nep141:base-usdc", refundTo: "0x1" }) });
    expect(res.status).toBe(409);
  });

  it("quotes exactly the clause amount, delivered to the clause account", async () => {
    const oc = oneClick();
    await start({ writer, oneClick: oc });
    const { proposalId } = await openAndBind();
    const res = await fetch(`${base}/clauses/${proposalId}/fund/quote`, { method: "POST", headers: json, body: JSON.stringify({ originAsset: "nep141:base-usdc", refundTo: "0x1", dry: false }) });
    expect(res.status).toBe(200);
    const req = vi.mocked(oc.quote).mock.calls[0]![0];
    expect(req).toMatchObject({ recipient: "r-104.clausehold.testnet", recipientType: "DESTINATION_CHAIN", swapType: "EXACT_OUTPUT", amount: "2000000", destinationAsset: "nep141:usdc.fake.near" });
    expect(store.entries.some((e) => e.type === "CLAUSE_FUNDING_QUOTED")).toBe(true);
  });

  it("refuses a quote that would leave the clause short", async () => {
    await start({ writer, oneClick: oneClick("1999999") });
    const { proposalId } = await openAndBind();
    const res = await fetch(`${base}/clauses/${proposalId}/fund/quote`, { method: "POST", headers: json, body: JSON.stringify({ originAsset: "nep141:base-usdc", refundTo: "0x1", dry: false }) });
    expect(res.status).toBe(422);
  });
});

describe("POST /relay", () => {
  it("is 503 without a relayer", async () => {
    await start({});
    expect((await fetch(`${base}/relay`, { method: "POST", headers: json, body: JSON.stringify({ signedDelegate: "x".repeat(20) }) })).status).toBe(503);
  });

  it("relays and records the delivery", async () => {
    await start({ relay: async () => ({ txHash: "TXD", senderId: "r-104.clausehold.testnet" }) });
    const res = await fetch(`${base}/relay`, { method: "POST", headers: json, body: JSON.stringify({ signedDelegate: "x".repeat(20) }) });
    expect(await res.json()).toEqual({ txHash: "TXD", senderId: "r-104.clausehold.testnet" });
    expect(store.entries.find((e) => e.type === "CLAUSE_DELIVERED")?.payload).toMatchObject({ txHash: "TXD" });
  });

  it("a refused delegate is a 422 and records nothing", async () => {
    await start({
      relay: async () => {
        throw new RelayRefusedError("bad signature");
      },
    });
    const res = await fetch(`${base}/relay`, { method: "POST", headers: json, body: JSON.stringify({ signedDelegate: "x".repeat(20) }) });
    expect(res.status).toBe(422);
    expect(store.entries).toHaveLength(0);
  });
});
