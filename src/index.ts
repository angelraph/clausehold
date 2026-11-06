#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./cli/commands/init.js";
import { clauseProposeCommand } from "./cli/commands/clause.js";
import { auditTailCommand, auditVerifyCommand } from "./cli/commands/audit.js";
import { mandateCompileCommand } from "./cli/commands/mandate.js";
import { startApiServer, DEMO_MANDATE_ID } from "./api/server.js";
import { depsFromConfig } from "./api/deps.js";
import { startDashboard } from "./cli/ui.js";
import { agentAddCommand, agentListCommand, agentRevokeCommand, agentRotateCommand } from "./cli/commands/agents.js";
import { approvalsListCommand, approveCommand, controlStatusCommand, haltCommand, rejectCommand, resumeCommand } from "./cli/commands/control.js";

const program = new Command();

program
  .name("clausehold")
  .description("Clausehold: pay a person or an agent for a finished job. The money is held under a clause, and the clause is the only key that moves it.")
  .version("0.2.0");

program
  .command("init")
  .description("Activate the demo mandate")
  .action(async () => {
    await initCommand();
  });

interface ClauseCliOptions {
  buyer: string;
  asset: string;
  terms: string;
  minutes: number;
  challenge: number;
  mandate: string;
  agent: string;
}

program
  .command("clause")
  .description("Propose a clause: check it against the mandate for a PASS / VETO / ESCALATE verdict before anyone signs")
  .argument("<payee>", "NEAR account to be paid on release")
  .argument("<amount>", "amount in stablecoin units", parseFloat)
  .requiredOption("--buyer <account>", "NEAR account that funds the clause and receives the return on expiry")
  .requiredOption("--terms <text>", "what must be delivered")
  .option("--asset <symbol>", "asset to pay in", "USDC")
  .option("--minutes <n>", "minutes until the clause expires and returns", parseFloat, 15)
  .option("--challenge <secs>", "seconds after delivery during which the buyer may freeze", (v) => parseInt(v, 10), 0)
  .option("--mandate <id>", "mandate id", DEMO_MANDATE_ID)
  .option("--agent <id>", "identifier of the agent proposing", "cli-operator")
  .action(async (payee: string, amount: number, opts: ClauseCliOptions) => {
    await clauseProposeCommand({
      agentId: opts.agent,
      mandateId: opts.mandate,
      buyer: opts.buyer,
      payee,
      asset: opts.asset,
      amount,
      terms: opts.terms,
      deadlineMinutes: opts.minutes,
      challengeSecs: opts.challenge,
    });
  });

program
  .command("dashboard")
  .description("Live terminal desk: mandate, verdicts, clause lifecycle. Polls the audit log.")
  .action(() => {
    startDashboard();
  });

program
  .command("serve")
  .description("Start the local HTTP API agents propose clauses against (POST /clauses)")
  .action(() => {
    startApiServer(depsFromConfig());
  });

const mandate = program.command("mandate").description("Manage mandates (a treasury's rule, compiled into live policy)");

mandate
  .command("compile")
  .description("Compile a plain-English rule into a draft mandate with NEAR AI Cloud, then activate it on confirmation")
  .argument("<text>", "the rule, in plain English")
  .requiredOption("--owner <account>", "who sets the mandate, e.g. the DAO account")
  .option("--factory <account>", "factory contract the mandate governs")
  .action(async (text: string, opts: { owner: string; factory?: string }) => {
    await mandateCompileCommand(text, opts.owner, opts.factory);
  });

program
  .command("approvals")
  .description("List escalated clauses waiting on, or already given, a second person's decision")
  .option("--status <status>", "pending, granted, rejected, or expired")
  .action(async (opts: { status?: string }) => {
    await approvalsListCommand(opts.status);
  });

program
  .command("approve")
  .description("Approve an escalated clause. It is re-checked against current conditions, then cleared.")
  .argument("<approvalId>")
  .option("--approver <name>", "who is approving (defaults to your OS username)")
  .option("--note <text>", "reason recorded in the audit log")
  .action(async (approvalId: string, opts: { approver?: string; note?: string }) => {
    await approveCommand(approvalId, opts.approver, opts.note);
  });

program
  .command("reject")
  .description("Reject an escalated clause. Nothing is written.")
  .argument("<approvalId>")
  .option("--approver <name>", "who is rejecting (defaults to your OS username)")
  .option("--note <text>", "reason recorded in the audit log")
  .action(async (approvalId: string, opts: { approver?: string; note?: string }) => {
    await rejectCommand(approvalId, opts.approver, opts.note);
  });

program
  .command("halt")
  .description("Engage the kill switch: no new clause is written until it is released")
  .option("--by <name>", "who is halting (defaults to your OS username)")
  .option("--reason <text>", "why, recorded in the audit log")
  .action(async (opts: { by?: string; reason?: string }) => {
    await haltCommand(opts.by, opts.reason);
  });

program
  .command("resume")
  .description("Release the kill switch")
  .option("--by <name>", "who is resuming (defaults to your OS username)")
  .action(async (opts: { by?: string }) => {
    await resumeCommand(opts.by);
  });

program
  .command("status")
  .description("Show whether the kill switch is engaged and how many approvals are pending")
  .action(async () => {
    await controlStatusCommand();
  });

const agent = program.command("agent").description("Register the agents allowed to propose clauses, each with its own key bound to specific mandates");

agent
  .command("add")
  .description("Register an agent and print its key once")
  .argument("<agentId>")
  .requiredOption("--mandate <id...>", "mandate id(s) this agent may propose against")
  .option("--by <name>", "who is registering (defaults to your OS username)")
  .action(async (agentId: string, opts: { mandate: string[]; by?: string }) => {
    await agentAddCommand(agentId, opts.mandate, opts.by);
  });

agent
  .command("rotate")
  .description("Issue a new key for an agent; the old one stops working immediately")
  .argument("<agentId>")
  .option("--by <name>")
  .action(async (agentId: string, opts: { by?: string }) => {
    await agentRotateCommand(agentId, opts.by);
  });

agent
  .command("revoke")
  .description("Revoke an agent's key")
  .argument("<agentId>")
  .option("--by <name>")
  .action(async (agentId: string, opts: { by?: string }) => {
    await agentRevokeCommand(agentId, opts.by);
  });

agent
  .command("list")
  .description("List registered agents")
  .action(async () => {
    await agentListCommand();
  });

const audit = program.command("audit").description("Inspect the hash-chained audit log");

audit
  .command("tail")
  .description("Show the last N audit entries")
  .argument("[n]", "number of entries", "20")
  .action(async (n: string) => {
    await auditTailCommand(parseInt(n, 10));
  });

audit
  .command("verify")
  .description("Verify the audit log's hash chain is intact")
  .action(async () => {
    await auditVerifyCommand();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  // Not process.exit(): on Windows that can trip a libuv assertion while
  // network handles are still closing. Setting the code lets the process drain.
  process.exitCode = 1;
});
