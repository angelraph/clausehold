import "dotenv/config";
import chalk from "chalk";

/**
 * A separate OS process playing a studio's buyer agent. It only talks to
 * Clausehold's HTTP API and never imports its internals, so its refusals
 * are as real as any other agent's. It proposes a mix of clauses: ones that
 * fit the demo mandate, one that needs a second person, and ones that break
 * it on purpose.
 */

const PORT = process.env.CLAUSEHOLD_API_PORT ?? "4477";
const BASE_URL = process.env.CLAUSEHOLD_BASE_URL ?? `http://localhost:${PORT}`;
const API_KEY = process.env.CLAUSEHOLD_API_KEY;
const MANDATE_ID = process.env.CLAUSEHOLD_DEMO_MANDATE_ID ?? "b2f1e9a0-1a2b-4c3d-8e4f-000000000001";
const BUYER = process.env.CLAUSEHOLD_STUDIO_ACCOUNT ?? "studio-agent.testnet";
const EDITOR = process.env.CLAUSEHOLD_EDITOR_ACCOUNT ?? "editor.testnet";

interface ScriptedClause {
  label: string;
  payee: string;
  asset: string;
  amount: number;
  terms: string;
  deadlineMinutes: number;
}

// Against demo-mandate.json: maxPerClause 25, confirmAbove 15, newPayeeCeiling 10, assets USDC/USDT.
const SCRIPT: ScriptedClause[] = [
  { label: "cut a file to 30s, new editor, within the ceiling", payee: EDITOR, asset: "USDC", amount: 2, terms: "Cut intro.mp4 to 30 seconds. Delivery is the file hash, signed with the editor's passkey.", deadlineMinutes: 15 },
  { label: "over the new-payee ceiling", payee: "stranger.testnet", asset: "USDC", amount: 12, terms: "Write a launch thread.", deadlineMinutes: 60 },
  { label: "over the per-clause cap", payee: EDITOR, asset: "USDC", amount: 40, terms: "Full brand video.", deadlineMinutes: 60 },
  { label: "asset outside the mandate", payee: EDITOR, asset: "NEAR", amount: 5, terms: "Thumbnail set.", deadlineMinutes: 60 },
  { label: "open longer than the mandate allows", payee: EDITOR, asset: "USDC", amount: 3, terms: "Monthly retainer.", deadlineMinutes: 60 * 24 * 30 },
];

async function proposeOnce(c: ScriptedClause): Promise<void> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/clauses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(API_KEY ? { "X-Clausehold-Api-Key": API_KEY } : {}) },
      body: JSON.stringify({
        agentId: "studio-agent",
        mandateId: MANDATE_ID,
        buyer: BUYER,
        payee: c.payee,
        asset: c.asset,
        amount: c.amount,
        terms: c.terms,
        deadlineMinutes: c.deadlineMinutes,
      }),
    });
    const json = (await res.json()) as {
      error?: string;
      verdict?: { decision: string; reasons: Array<{ rule: string; outcome: string; detail: string }> };
      cleared?: boolean;
      approval?: { approvalId: string } | null;
    };
    const ms = Date.now() - started;
    if (!json.verdict) {
      console.log(chalk.red(`[studio-agent] ${c.label} -> HTTP ${res.status}: ${json.error ?? "no verdict"}`));
      return;
    }
    const d = json.verdict.decision;
    const color = d === "PASS" ? chalk.green : d === "VETO" ? chalk.red : chalk.yellow;
    console.log(color(`[studio-agent] ${c.label} -> ${d} (${ms}ms)`));
    for (const r of json.verdict.reasons.filter((r) => r.outcome !== "ok")) console.log(chalk.dim(`    ${r.rule}: ${r.detail}`));
    if (json.approval) console.log(chalk.yellow(`    waiting on a second person (${json.approval.approvalId.slice(0, 8)}); this agent has no credential to approve it`));
    if (json.cleared) console.log(chalk.green("    cleared to be written on chain"));
  } catch (err) {
    console.error(chalk.red(`[studio-agent] ${c.label} -> request failed: ${err instanceof Error ? err.message : err}`));
  }
}

async function main() {
  console.log(chalk.bold(`\nstudio-agent: proposing clauses to Clausehold at ${BASE_URL}\n`));
  console.log("Run `clausehold serve` and `clausehold init` first.\n");
  for (const c of SCRIPT) {
    await proposeOnce(c);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(chalk.bold("\nstudio-agent run complete."));
}

main();
