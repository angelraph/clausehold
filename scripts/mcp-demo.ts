/**
 * Two AI agents, one job, through the Clausehold MCP server.
 *
 *   npm run mcp:demo
 *
 * Starts two copies of the MCP server over stdio, the way Claude Code or
 * Cursor would: one runs as the buyer agent, one as the worker agent, each
 * with its own NEAR account and key. The buyer checks the worker's standing,
 * opens a 2 mUSD job, and funds it once the worker accepts. The worker
 * delivers without paying gas, gets paid in the same transaction, and the
 * buyer closes the clause to get its storage deposit back.
 *
 * Env: CLAUSEHOLD_DEMO_BUYER (default clausehold-ops.testnet) and
 * CLAUSEHOLD_DEMO_WORKER (default clausehold.testnet), keys in ~/.near-credentials/testnet.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUYER = process.env.CLAUSEHOLD_DEMO_BUYER ?? "clausehold-ops.testnet";
const WORKER = process.env.CLAUSEHOLD_DEMO_WORKER ?? "clausehold.testnet";

async function agent(name: string, account: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["node_modules/tsx/dist/cli.mjs", "src/mcp/server.ts"],
    env: { ...(process.env as Record<string, string>), CLAUSEHOLD_AGENT_ACCOUNT: account },
    stderr: "inherit",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call<T>(who: Client, label: string, tool: string, args: Record<string, unknown>): Promise<T> {
  const r = (await who.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content.map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${tool}: ${text}`);
  const out = JSON.parse(text) as T;
  console.log(`\n${label}  [${tool}]`);
  console.log(text.split("\n").map((l) => `   ${l}`).join("\n"));
  return out;
}

async function main() {
  console.log(`Buyer agent ${BUYER}, worker agent ${WORKER}`);
  const buyer = await agent("buyer-agent", BUYER);
  const worker = await agent("worker-agent", WORKER);
  const tools = await buyer.listTools();
  console.log(`MCP tools: ${tools.tools.map((t) => t.name).join(", ")}`);

  await call(buyer, "1. Buyer checks the worker's record", "clausehold_check_payee", { payee: WORKER });
  const job = await call<{ decision: string; inviteId: string | null }>(buyer, "2. Buyer opens a job", "clausehold_open_job", {
    payee: WORKER,
    amount: 2,
    terms: "Summarise the NEAR Intents 1Click docs in five bullet points.",
    minutes: 30,
  });
  if (job.decision !== "PASS" || !job.inviteId) throw new Error(`The mandate did not clear the job: ${job.decision}`);
  await call(worker, "3. Worker accepts and makes its job key", "clausehold_accept_job", { inviteId: job.inviteId });
  await call(buyer, "4. Buyer writes the clause and funds it", "clausehold_write_and_fund", { inviteId: job.inviteId });
  await call(worker, "5. Worker delivers, no gas", "clausehold_deliver", {
    inviteId: job.inviteId,
    work: "1Click: quote, deposit address, deposit, status polling, delivery on the destination chain.",
  });
  const status = await call<{ state: string; closable: boolean }>(buyer, "6. Buyer checks the job", "clausehold_status", { inviteId: job.inviteId });
  if (status.state !== "released") throw new Error(`Expected released, got ${status.state}`);
  await call(buyer, "7. Buyer closes it and gets the storage NEAR back", "clausehold_close", { inviteId: job.inviteId });
  await call(buyer, "8. The worker's record now", "clausehold_check_payee", { payee: WORKER });

  await buyer.close();
  await worker.close();
  console.log("\nPassed: one agent hired another and paid only for delivered work.");
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
