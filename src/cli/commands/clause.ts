import { runClause, type RunClauseInput } from "../../policy/runClause.js";

export async function clauseProposeCommand(input: RunClauseInput): Promise<void> {
  console.log(`\n${input.agentId} wants to hold ${input.amount} ${input.asset.toUpperCase()} for ${input.payee}, open ${input.deadlineMinutes} min`);
  console.log(`  terms: "${input.terms}"`);

  const { proposal, verdict, cleared, approval } = await runClause(input);

  console.log(`\nVerdict: ${verdict.decision}`);
  for (const r of verdict.reasons) {
    const marker = r.outcome === "violated" ? "✗" : r.outcome === "warning" ? "!" : "✓";
    console.log(`  [${marker}] ${r.rule}: ${r.detail}`);
  }

  if (verdict.decision === "VETO") {
    console.log("\nRefused before signature. Nothing was written and no wallet was asked to sign.");
    return;
  }

  if (approval) {
    console.log(
      `\nESCALATE. This clause is above the confirm threshold, so it waits for a second person.\n` +
        `  approval id: ${approval.approvalId}\n` +
        `  expires:     ${approval.expiresAt}\n` +
        `A different person approves it with:\n` +
        `  clausehold approve ${approval.approvalId} --approver <name>`
    );
    return;
  }

  if (cleared) {
    console.log(`\nCLEARED. Clause ${proposal.id} may now be written on chain, expiring ${proposal.deadline}.`);
  }
}
