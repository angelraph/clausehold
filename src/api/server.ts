import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { config } from "../config.js";
import { runClause, type RunClauseResult } from "../policy/runClause.js";
import { loadMandate, MandateNotFoundError } from "../mandate/store.js";
import { auditLog } from "../audit/log.js";
import {
  ApprovalBlockedError,
  ApprovalNotFoundError,
  ApprovalStateError,
  AuditIntegrityError,
  SelfApprovalError,
  approve,
  engageKillSwitch,
  getApproval,
  getKillSwitch,
  listApprovals,
  reject,
  releaseKillSwitch,
} from "../approval/service.js";
import type { ApprovalStatus } from "../approval/state.js";
import { authenticateAgent, constantTimeEquals, registryInUse } from "../agents/service.js";
import type { AgentRecord } from "../agents/state.js";
import {
  InviteNotFoundError,
  InviteStateError,
  bindKey,
  findInviteByProposal,
  getInvite,
  openInvite,
  publicInviteView,
  writeIfReady,
} from "../invites/service.js";
import type { ClauseWriter } from "../near/clauseWriter.js";
import { deriveDesk } from "../desk/view.js";
import { OneClickError, assertQuoteFundsClause, buildClauseFundingQuote, findToken, type OneClickClient } from "../near/intents.js";
import { RelayRefusedError, type RelayResult } from "../near/relayer.js";
import { toBaseUnits } from "../near/network.js";

/**
 * What the API needs from the outside world. Each is optional: a route whose
 * dependency is missing answers 503 and says what to configure, rather than
 * pretending. Tests pass fakes here.
 */
export interface ApiDeps {
  writer?: ClauseWriter;
  oneClick?: OneClickClient;
  relay?: (signedDelegateBase64: string) => Promise<RelayResult>;
}

export const DEMO_MANDATE_ID = "b2f1e9a0-1a2b-4c3d-8e4f-000000000001";

const ClauseBodySchema = z.object({
  /** Required when the caller uses the shared key or no key. For a registered agent it is ignored, and must match if given. */
  agentId: z.string().min(1).optional(),
  mandateId: z.string().uuid(),
  buyer: z.string().min(2),
  payee: z.string().min(2),
  asset: z.string().min(1).default("USDC"),
  amount: z.number().positive(),
  terms: z.string().min(1).max(2000),
  deadlineMinutes: z.number().positive(),
  challengeSecs: z.number().int().min(0).optional(),
});

const DecisionBodySchema = z.object({ note: z.string().optional() });
const KeyBodySchema = z.object({ publicKey: z.string().min(10), keySource: z.enum(["passkey-prf", "browser-random"]) });
const QuoteBodySchema = z.object({
  /** 1Click assetId of what the payer holds, e.g. USDC on Base. */
  originAsset: z.string().min(3),
  /** The payer's address on the origin chain, for a failed swap. */
  refundTo: z.string().min(3),
  dry: z.boolean().optional().default(true),
  slippageBps: z.number().int().min(0).max(1000).optional(),
});
const RelayBodySchema = z.object({ signedDelegate: z.string().min(16) });

/**
 * Routes anyone may call without an agent key. The invite id in the path is
 * the capability; the relay validates every delegate itself before paying.
 */
function isPublicRoute(method: string, path: string): boolean {
  if (method === "GET" && /^\/invites\/[^/]+$/.test(path)) return true;
  if (method === "POST" && /^\/invites\/[^/]+\/key$/.test(path)) return true;
  if (method === "POST" && /^\/clauses\/[^/]+\/fund\/quote$/.test(path)) return true;
  if (method === "GET" && /^\/funding\/[^/]+$/.test(path)) return true;
  if (method === "POST" && path === "/relay") return true;
  return false;
}
const HaltBodySchema = z.object({ reason: z.string().optional() });

/** Routes that decide something (approve, reject, halt, resume) rather than propose it. */
function isApproverRoute(path: string): boolean {
  return path.startsWith("/approvals") || path.startsWith("/control");
}

function view(result: RunClauseResult) {
  return {
    proposalId: result.proposal.id,
    proposal: result.proposal,
    verdict: result.verdict,
    cleared: result.cleared,
    approval: result.approval ?? null,
  };
}

/**
 * The surface agents (and the studio-agent demo process) call.
 *
 * Two separate credentials, on purpose:
 *   - CLAUSEHOLD_API_KEY (X-Clausehold-Api-Key) lets a caller propose
 *     clauses and read the outcome of its own.
 *   - CLAUSEHOLD_APPROVER_KEY (X-Clausehold-Approver-Key, plus
 *     X-Clausehold-Approver naming who is deciding) is required to approve,
 *     reject, halt, or resume. An agent holding only the first key can never
 *     approve its own escalation.
 */
export function createApp(deps: ApiDeps = {}): express.Express {
  const app = express();
  app.use(express.json());

  // Only the web app's own origins may call the API from a browser.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get("Origin");
    if (origin && (config.webOrigins ?? []).includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Headers", "Content-Type, X-Clausehold-Api-Key, X-Clausehold-Approver-Key, X-Clausehold-Approver");
      res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (isPublicRoute(req.method, req.path)) {
      next();
      return;
    }
    if (isApproverRoute(req.path)) {
      if (!config.approverKey) {
        res.status(403).json({ error: "Approver endpoints are disabled: CLAUSEHOLD_APPROVER_KEY is not set on this server" });
        return;
      }
      const presentedApprover = req.get("X-Clausehold-Approver-Key");
      if (!presentedApprover || !constantTimeEquals(presentedApprover, config.approverKey)) {
        res.status(401).json({ error: "Missing or invalid X-Clausehold-Approver-Key header" });
        return;
      }
      if (!req.get("X-Clausehold-Approver")) {
        res.status(400).json({ error: "X-Clausehold-Approver header is required and must name who is deciding" });
        return;
      }
      next();
      return;
    }

    try {
      const presented = req.get("X-Clausehold-Api-Key");

      // A registered agent's own key identifies it. From here on its identity
      // comes from the key, never from anything the request body claims.
      const agent = await authenticateAgent(presented);
      if (agent) {
        res.locals.agent = agent;
        next();
        return;
      }

      // The single shared key. Refused outright when CLAUSEHOLD_REQUIRE_AGENT_KEYS=true.
      if (!config.requireAgentKeys && config.apiKey && presented && constantTimeEquals(presented, config.apiKey)) {
        next();
        return;
      }

      // Nothing configured at all: open, for local development.
      if (!config.requireAgentKeys && !config.apiKey && !(await registryInUse())) {
        next();
        return;
      }

      res.status(401).json({ error: "Missing or invalid X-Clausehold-Api-Key header" });
    } catch (err) {
      next(err);
    }
  });

  // In-memory index of recent results for GET /clauses/:id. The audit log
  // remains the durable source of truth; this is just a fast lookup cache.
  const recent = new Map<string, RunClauseResult>();

  const approver = (req: Request): string => req.get("X-Clausehold-Approver") as string;

  app.post("/clauses", async (req: Request, res: Response) => {
    const parsed = ClauseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid clause", issues: parsed.error.issues });
      return;
    }
    const agent = res.locals.agent as AgentRecord | undefined;
    let agentId = parsed.data.agentId;
    if (agent) {
      if (agentId !== undefined && agentId !== agent.agentId) {
        res.status(403).json({ error: `This key belongs to agent "${agent.agentId}". It cannot propose as "${agentId}".` });
        return;
      }
      if (!agent.mandateIds.includes(parsed.data.mandateId)) {
        res.status(403).json({ error: `Agent "${agent.agentId}" is not bound to mandate ${parsed.data.mandateId}` });
        return;
      }
      agentId = agent.agentId;
    }
    if (!agentId) {
      res.status(400).json({ error: "agentId is required when not using a registered agent key" });
      return;
    }

    try {
      const result = await runClause({ ...parsed.data, agentId });
      recent.set(result.proposal.id, result);
      res.status(200).json(view(result));
    } catch (err) {
      if (err instanceof MandateNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid clause", issues: err.issues });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/clauses/:id", (req: Request, res: Response) => {
    const result = recent.get(req.params.id as string);
    const agent = res.locals.agent as AgentRecord | undefined;
    // A registered agent only ever sees its own clauses. Someone else's is
    // reported as unknown, so its existence is not revealed either.
    if (!result || (agent && result.proposal.agentId !== agent.agentId)) {
      res.status(404).json({ error: "Unknown clause id (not seen since this server started)" });
      return;
    }
    res.json(view(result));
  });

  // What an agent polls after an ESCALATE: only the outcome, never the clause detail.
  app.get("/escalations/:approvalId", async (req: Request, res: Response) => {
    try {
      const record = await getApproval(req.params.approvalId as string);
      const agent = res.locals.agent as AgentRecord | undefined;
      if (agent && record.proposal.agentId !== agent.agentId) {
        throw new ApprovalNotFoundError(record.approvalId);
      }
      res.json({
        approvalId: record.approvalId,
        status: record.status,
        expiresAt: record.expiresAt,
        resolvedAt: record.resolvedAt ?? null,
      });
    } catch (err) {
      if (err instanceof ApprovalNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/approvals", async (req: Request, res: Response) => {
    const status = req.query.status as ApprovalStatus | undefined;
    res.json(await listApprovals(status));
  });

  const decide =
    (action: "approve" | "reject") =>
    async (req: Request, res: Response): Promise<void> => {
      const body = DecisionBodySchema.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: "Invalid body", issues: body.error.issues });
        return;
      }
      const id = req.params.id as string;
      try {
        if (action === "approve") {
          const outcome = await approve(id, approver(req), body.data.note);
          // The approval stands on its own. If the editor's key is already
          // bound, write the clause now. A chain error is reported to the
          // caller rather than hidden, and the approval is not undone by it.
          let invite = null;
          let writeError: string | null = null;
          try {
            const found = await findInviteByProposal(outcome.record.proposal.id);
            if (found) invite = publicInviteView(await writeIfReady(found.inviteId, deps.writer));
          } catch (err) {
            writeError = err instanceof Error ? err.message : String(err);
          }
          res.json({ approval: outcome.record, verdict: outcome.verdict, cleared: true, invite, writeError });
        } else {
          res.json({ approval: await reject(id, approver(req), body.data.note) });
        }
      } catch (err) {
        if (err instanceof ApprovalNotFoundError) {
          res.status(404).json({ error: err.message });
        } else if (err instanceof ApprovalStateError) {
          res.status(409).json({ error: err.message, status: err.status });
        } else if (err instanceof SelfApprovalError) {
          res.status(403).json({ error: err.message });
        } else if (err instanceof ApprovalBlockedError) {
          res.status(422).json({ error: err.message, verdict: err.verdict });
        } else if (err instanceof AuditIntegrityError) {
          res.status(500).json({ error: err.message });
        } else {
          res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    };

  app.post("/approvals/:id/approve", decide("approve"));
  app.post("/approvals/:id/reject", decide("reject"));

  app.get("/control", async (_req: Request, res: Response) => {
    res.json({ killSwitch: await getKillSwitch(), pendingApprovals: (await listApprovals("pending")).length });
  });

  app.post("/control/halt", async (req: Request, res: Response) => {
    const body = HaltBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "Invalid body", issues: body.error.issues });
      return;
    }
    res.json({ killSwitch: await engageKillSwitch(approver(req), body.data.reason) });
  });

  app.post("/control/resume", async (req: Request, res: Response) => {
    res.json({ killSwitch: await releaseKillSwitch(approver(req)) });
  });

  app.get("/mandate", async (req: Request, res: Response) => {
    const id = (req.query.id as string) ?? DEMO_MANDATE_ID;
    try {
      res.json(await loadMandate(id));
    } catch {
      res.status(404).json({ error: `No mandate found with id ${id}` });
    }
  });

  app.get("/desk/clauses", async (_req: Request, res: Response) => {
    const agent = res.locals.agent as AgentRecord | undefined;
    const rows = deriveDesk(await auditLog.all());
    // A registered agent sees only its own clauses.
    res.json(agent ? rows.filter((r) => r.proposal.agentId === agent.agentId) : rows);
  });

  app.get("/audit/tail", async (req: Request, res: Response) => {
    const n = parseInt((req.query.n as string) ?? "20", 10);
    res.json(await auditLog.tail(n));
  });

  // ---- Invites: the editor's key exists before the clause is written ----

  app.post("/invites", async (req: Request, res: Response) => {
    const parsed = ClauseBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid clause", issues: parsed.error.issues });
      return;
    }
    const agent = res.locals.agent as AgentRecord | undefined;
    let agentId = parsed.data.agentId;
    if (agent) {
      if (agentId !== undefined && agentId !== agent.agentId) {
        res.status(403).json({ error: `This key belongs to agent "${agent.agentId}". It cannot propose as "${agentId}".` });
        return;
      }
      if (!agent.mandateIds.includes(parsed.data.mandateId)) {
        res.status(403).json({ error: `Agent "${agent.agentId}" is not bound to mandate ${parsed.data.mandateId}` });
        return;
      }
      agentId = agent.agentId;
    }
    if (!agentId) {
      res.status(400).json({ error: "agentId is required when not using a registered agent key" });
      return;
    }
    try {
      const result = await runClause({ ...parsed.data, agentId });
      recent.set(result.proposal.id, result);
      if (result.verdict.decision === "VETO") {
        res.status(200).json({ ...view(result), invite: null });
        return;
      }
      const { inviteId } = await openInvite(result.proposal);
      res.status(200).json({ ...view(result), invite: { inviteId, path: `/w/${inviteId}` } });
    } catch (err) {
      if (err instanceof MandateNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid clause", issues: err.issues });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/invites/:id", async (req: Request, res: Response) => {
    try {
      res.json(publicInviteView(await getInvite(req.params.id as string)));
    } catch (err) {
      if (err instanceof InviteNotFoundError) {
        res.status(404).json({ error: "Unknown invite" });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/invites/:id/key", async (req: Request, res: Response) => {
    const body = KeyBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "Invalid key", issues: body.error.issues });
      return;
    }
    try {
      const rec = await bindKey(req.params.id as string, body.data.publicKey, body.data.keySource, deps.writer);
      const pendingReason = rec.status === "written" ? null : !rec.cleared ? "waiting for a second person to approve the clause" : !deps.writer ? "no chain writer is configured on this server" : null;
      res.json({ invite: publicInviteView(rec), pendingReason });
    } catch (err) {
      if (err instanceof InviteNotFoundError) {
        res.status(404).json({ error: "Unknown invite" });
      } else if (err instanceof InviteStateError) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(502).json({ error: `Could not write the clause on chain: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  });

  // ---- Funding through NEAR Intents (mainnet) ----

  const USDC_DECIMALS = 6;

  app.post("/clauses/:id/fund/quote", async (req: Request, res: Response) => {
    if (!deps.oneClick) {
      res.status(503).json({ error: "Intents funding is not configured on this server" });
      return;
    }
    const body = QuoteBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "Invalid quote request", issues: body.error.issues });
      return;
    }
    const invite = await findInviteByProposal(req.params.id as string);
    if (!invite || invite.status !== "written" || !invite.clauseAccountId) {
      res.status(409).json({ error: "This clause is not on chain yet, so there is nothing to fund" });
      return;
    }
    try {
      const tokens = await deps.oneClick.tokens();
      const destination = findToken(tokens, "near", invite.proposal.asset);
      const quoteReq = buildClauseFundingQuote({
        originAsset: body.data.originAsset,
        destinationAsset: destination.assetId,
        amountBase: toBaseUnits(invite.proposal.amount, destination.decimals ?? USDC_DECIMALS),
        clauseAccountId: invite.clauseAccountId,
        refundTo: body.data.refundTo,
        deadline: new Date(Math.min(new Date(invite.proposal.deadline).getTime(), Date.now() + 60 * 60_000)),
        dry: body.data.dry,
        slippageBps: body.data.slippageBps,
      });
      const quote = await deps.oneClick.quote(quoteReq);
      assertQuoteFundsClause(quote, quoteReq);
      await auditLog.append("CLAUSE_FUNDING_QUOTED", config.network, {
        proposalId: invite.proposal.id,
        clauseAccountId: invite.clauseAccountId,
        dry: quoteReq.dry,
        depositAddress: quote.quote.depositAddress ?? null,
        amountIn: quote.quote.amountIn,
        amountOut: quote.quote.amountOut,
        correlationId: quote.correlationId,
      });
      res.json({ clauseAccountId: invite.clauseAccountId, destinationAsset: destination.assetId, quote });
    } catch (err) {
      if (err instanceof OneClickError) {
        res.status(502).json({ error: err.message });
        return;
      }
      res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/funding/:depositAddress", async (req: Request, res: Response) => {
    if (!deps.oneClick) {
      res.status(503).json({ error: "Intents funding is not configured on this server" });
      return;
    }
    try {
      res.json(await deps.oneClick.status(req.params.depositAddress as string));
    } catch (err) {
      res.status(err instanceof OneClickError ? 502 : 500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Gasless delivery ----

  app.post("/relay", async (req: Request, res: Response) => {
    if (!deps.relay) {
      res.status(503).json({ error: "No relayer is configured on this server" });
      return;
    }
    const body = RelayBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "Body must be { signedDelegate: <base64> }" });
      return;
    }
    try {
      const result = await deps.relay(body.data.signedDelegate);
      await auditLog.append("CLAUSE_DELIVERED", config.network, { clauseAccountId: result.senderId, txHash: result.txHash, relayed: true });
      res.json(result);
    } catch (err) {
      if (err instanceof RelayRefusedError) {
        res.status(422).json({ error: err.message });
        return;
      }
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Last resort: never return a stack trace or file paths to a caller.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Request body is not valid JSON" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export function startApiServer(deps: ApiDeps = {}): Server {
  void registryInUse().then((any) => {
    if (config.requireAgentKeys && !any) {
      console.log("Note: CLAUSEHOLD_REQUIRE_AGENT_KEYS is set but no agents have been registered, so every clause is refused until one is (clausehold agent add).");
    } else if (!config.requireAgentKeys && !config.apiKey && !any) {
      console.log("Warning: no CLAUSEHOLD_API_KEY is set and no agents have been registered. Anyone who can reach this API can propose clauses.");
    }
  });
  if (!config.approverKey) {
    console.log("Note: CLAUSEHOLD_APPROVER_KEY is not set, so the approve/reject/halt/resume endpoints are disabled. Use the CLI to decide.");
  }

  return createApp(deps).listen(config.apiPort, () => {
    console.log(`Clausehold API listening on http://localhost:${config.apiPort} (${config.network}, factory ${config.factoryAccountId})`);
    console.log(`  POST   /clauses                    (agent key)`);
    console.log(`  GET    /clauses/:id                (agent key)`);
    console.log(`  GET    /escalations/:approvalId    (agent key)`);
    console.log(`  POST   /invites                    (agent key)`);
    console.log(`  GET    /invites/:id                (public: the editor's link)`);
    console.log(`  POST   /invites/:id/key            (public: binds the editor's key)`);
    console.log(`  POST   /clauses/:id/fund/quote     (public: Intents quote${deps.oneClick ? "" : ", not configured"})`);
    console.log(`  POST   /relay                      (public: gasless delivery${deps.relay ? "" : ", not configured"})`);
    console.log(`  GET    /approvals                  (approver key)`);
    console.log(`  POST   /approvals/:id/approve      (approver key)`);
    console.log(`  POST   /approvals/:id/reject       (approver key)`);
    console.log(`  GET    /control                    (approver key)`);
    console.log(`  POST   /control/halt | /resume     (approver key)`);
    console.log(`  GET    /mandate?id=<mandateId>`);
    console.log(`  GET    /audit/tail?n=20`);
  });
}
