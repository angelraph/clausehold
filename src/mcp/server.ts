/**
 * Clausehold as an MCP server, so an AI agent can hire another agent (or a
 * person) and pay only for finished work.
 *
 *   npm run mcp
 *
 * Add to Claude Code:  claude mcp add clausehold -- npx tsx src/mcp/server.ts
 * (run from the repository, with CLAUSEHOLD_AGENT_ACCOUNT set to the testnet
 * account this agent pays from; its key is read from ~/.near-credentials).
 *
 * The same server works for both sides of a job. As the buyer it checks the
 * payee, opens the job, writes and funds the clause from its own key, and
 * closes it afterwards. As the worker it accepts the job (making the one key
 * the clause will accept) and delivers without gas.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AcceptanceCheckSchema } from "../verify/checks.js";
import { acceptJob, agentAccount, agentEnv, checkPayee, closeJob, deliver, jobStatus, openJob, writeAndFund } from "../agent/index.js";

const env = agentEnv();
const server = new McpServer({ name: "clausehold", version: "0.3.0" });

type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<Result> {
  try {
    const out = await fn();
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

server.registerTool(
  "clausehold_check_payee",
  {
    title: "Check a payee's earned standing",
    description:
      "Reads a NEAR account's record from the Clausehold factory: how many clauses it was paid through, how many were returned, and the largest single job it may be offered right now. Call this before hiring.",
    inputSchema: { payee: z.string().describe("NEAR account to be paid, e.g. editor.testnet") },
  },
  ({ payee }) => run(() => checkPayee(payee, env))
);

server.registerTool(
  "clausehold_open_job",
  {
    title: "Open a job (buyer)",
    description:
      "Proposes a paid job. The desk checks it against the treasury's mandate before anything is signed and answers PASS, VETO (with the rule that refused it) or ESCALATE. On PASS it returns an invite link and id for the worker.",
    inputSchema: {
      payee: z.string().describe("NEAR account that will be paid on delivery"),
      amount: z.number().positive().describe("Amount in dollars (mUSD on testnet, USDC on mainnet)"),
      terms: z.string().min(3).max(2000).describe("What must be delivered, in plain words"),
      minutes: z.number().int().positive().max(10080).optional().describe("Minutes until the job expires and the money returns (default 30)"),
      reviewSeconds: z.number().int().min(0).optional().describe("Seconds after delivery during which the buyer may freeze (default 0: delivery pays at once)"),
      check: AcceptanceCheckSchema.optional().describe("Optional acceptance check the desk runs on every delivery before relaying it: {kind:\"url_contains\",url,text}, {kind:\"github_pr_merged\",repo:\"owner/name\",pr}, or {kind:\"sha256\",value}"),
    },
  },
  (a) => run(() => openJob({ buyer: agentAccount(undefined, env).accountId, ...a }, env))
);

server.registerTool(
  "clausehold_accept_job",
  {
    title: "Accept a job (worker)",
    description:
      "Accepts an invite as the worker. Makes the only key the clause will ever accept (it can do nothing except deliver) and binds it to the job. The secret stays on this machine.",
    inputSchema: { inviteId: z.string().describe("Invite id from the invite link /w/<inviteId>") },
  },
  ({ inviteId }) => run(() => acceptJob(inviteId, env))
);

server.registerTool(
  "clausehold_write_and_fund",
  {
    title: "Write and fund the clause (buyer)",
    description:
      "After the worker accepted, the buyer's own key creates the clause on chain (a per-job account, about 2 NEAR storage deposit that comes back on close) and sends exactly the job amount into it. On testnet it tops up from the mUSD faucet first if needed.",
    inputSchema: { inviteId: z.string() },
  },
  ({ inviteId }) => run(() => writeAndFund(agentAccount(undefined, env), inviteId, env))
);

server.registerTool(
  "clausehold_deliver",
  {
    title: "Deliver the work (worker)",
    description:
      "Submits the delivery: its SHA-256 goes on chain, signed by the worker's job key as a meta-transaction that the desk relays (the worker pays no gas). With no review window the clause pays the worker in the same transaction.",
    inputSchema: {
      inviteId: z.string(),
      work: z.string().min(1).describe("The delivered work itself, or a link to it. Only its hash is published."),
    },
  },
  ({ inviteId, work }) => run(() => deliver(inviteId, work, env))
);

server.registerTool(
  "clausehold_status",
  {
    title: "Job status",
    description: "Where a job stands: not written, open, funded, delivered, released, returned or closed, with the clause account and an explorer link.",
    inputSchema: { inviteId: z.string() },
  },
  ({ inviteId }) => run(() => jobStatus(inviteId, env))
);

server.registerTool(
  "clausehold_close",
  {
    title: "Close a settled job",
    description: "Once a clause is released or returned, closing it deletes the clause account and sends its storage NEAR back to the buyer. Anyone may call it.",
    inputSchema: { inviteId: z.string() },
  },
  ({ inviteId }) =>
    run(async () => {
      const s = await jobStatus(inviteId, env);
      if (!s.clause) throw new Error("This job has no clause on chain");
      if (!s.closable) throw new Error(`The clause is ${s.state}; it can be closed once it is released or returned and recorded`);
      return closeJob(agentAccount(undefined, env), s.clause, env);
    })
);

await server.connect(new StdioServerTransport());
