import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
import { auditLog, type AuditEntry } from "../audit/log.js";
import { loadMandate } from "../mandate/store.js";
import type { Mandate } from "../mandate/schema.js";
import type { Verdict } from "../policy/types.js";
import { deriveApprovals, deriveKillSwitch, type ApprovalRecord, type KillSwitchState } from "../approval/state.js";
import { config } from "../config.js";
import { DEMO_MANDATE_ID } from "../api/server.js";

const POLL_MS = 4000;

function decisionColor(decision: string): string {
  if (decision === "PASS") return "green";
  if (decision === "VETO") return "red";
  if (decision === "ESCALATE") return "yellow";
  return "white";
}

function verdictLine(e: AuditEntry): { text: string; color: string } | null {
  if (e.type !== "VERDICT_ISSUED") return null;
  const { verdict } = e.payload as { verdict: Verdict };
  return {
    text: `#${e.seq} ${e.timestamp.slice(11, 19)}  ${verdict.decision.padEnd(8)} ${String(verdict.amount).padStart(8)} ${verdict.asset}  clause ${verdict.proposalId.slice(0, 8)}`,
    color: decisionColor(verdict.decision),
  };
}

const LIFECYCLE = new Set(["CLAUSE_CLEARED", "CLAUSE_CREATED", "CLAUSE_FUNDED", "CLAUSE_DELIVERED", "CLAUSE_RELEASED", "CLAUSE_RETURNED", "CLAUSE_FROZEN"]);

function lifecycleLine(e: AuditEntry): string | null {
  if (!LIFECYCLE.has(e.type)) return null;
  const p = e.payload as { proposal?: { id: string; payee: string; amount: number; asset: string }; account?: string };
  const what = p.proposal ? `${p.proposal.amount} ${p.proposal.asset} to ${p.proposal.payee}` : (p.account ?? "");
  return `#${e.seq} ${e.timestamp.slice(11, 19)}  ${e.type.replace("CLAUSE_", "").padEnd(9)} ${what}`;
}

const App: React.FC = () => {
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [killSwitch, setKillSwitch] = useState<KillSwitchState>({ engaged: false });
  const [pending, setPending] = useState<ApprovalRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [m, all] = await Promise.all([loadMandate(DEMO_MANDATE_ID).catch(() => null), auditLog.all()]);
        if (cancelled) return;
        setMandate(m);
        setEntries(all.slice(-20));
        setKillSwitch(deriveKillSwitch(all));
        setPending([...deriveApprovals(all).values()].filter((r) => r.status === "pending"));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    poll();
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      poll();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const verdicts = entries.map(verdictLine).filter((v): v is { text: string; color: string } => v !== null);
  const lifecycle = entries.map(lifecycleLine).filter((l): l is string => l !== null);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        Clausehold desk ({config.network}, {config.factoryAccountId}), refresh #{tick}
      </Text>
      <Text dimColor>The money is held under a clause, and the clause is the only key that moves it.</Text>
      <Box marginTop={1} flexDirection="column">
        {error && <Text color="red">Error: {error}</Text>}
        {killSwitch.engaged && (
          <Box borderStyle="bold" borderColor="red" paddingX={1} marginBottom={1}>
            <Text bold color="red">
              NEW CLAUSES HALTED{killSwitch.by ? ` by ${killSwitch.by}` : ""}{killSwitch.reason ? `: ${killSwitch.reason}` : ""}.
            </Text>
          </Box>
        )}
        {pending.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
            <Text bold color="yellow">Waiting on a second person ({pending.length})</Text>
            {pending.map((r) => (
              <Text key={r.approvalId} color="yellow">
                {r.approvalId.slice(0, 8)}  {r.proposal.amount} {r.proposal.asset} to {r.proposal.payee}  from {r.proposal.agentId}  expires {r.expiresAt.slice(11, 19)}
              </Text>
            ))}
          </Box>
        )}
        {mandate && (
          <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
            <Text bold>Mandate {mandate.id.slice(0, 8)} ({mandate.status}), set by {mandate.owner}</Text>
            <Text>
              maxPerClause {mandate.limits.maxPerClause}  confirmAbove {mandate.limits.confirmAbove}  perPayee/day {mandate.limits.perPayeeDailyCap}  newPayee {mandate.limits.newPayeeCeiling}
            </Text>
            <Text dimColor>assets: {mandate.limits.allowedAssets.join(", ")}</Text>
          </Box>
        )}
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
          <Text bold>Verdicts (last {verdicts.length})</Text>
          {verdicts.length === 0 && <Text dimColor>No verdicts yet. Run `clausehold clause` or the studio agent.</Text>}
          {verdicts.map((v, i) => (
            <Text key={i} color={v.color}>
              {v.text}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
          <Text bold>Clause lifecycle (last {lifecycle.length})</Text>
          {lifecycle.length === 0 && <Text dimColor>No clauses yet.</Text>}
          {lifecycle.map((l, i) => (
            <Text key={i} color="green">
              {l}
            </Text>
          ))}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Ctrl+C to exit. Polling every {POLL_MS / 1000}s from the audit log.</Text>
      </Box>
    </Box>
  );
};

export function startDashboard(): void {
  render(<App />);
}
