/**
 * Earned standing: what a payee has proven on chain, and what that unlocks.
 * Pure functions here; the routes in server.ts feed them chain reads.
 */
import type { Standing } from "../near/standing.js";

/** The factory's mandate as stored on chain (token amounts in base units). */
export interface ChainMandate {
  allowed_assets: string[];
  max_per_clause: string;
  per_payee_daily_cap: string;
  daily_cap: string;
  new_payee_ceiling: string;
  paused: boolean;
  cosigner: string | null;
  creators?: string[];
}

/** One settled clause, as the factory records it (`get_receipts`). */
export interface ChainReceipt {
  clause_id: number;
  account_id: string;
  buyer: string;
  payee: string;
  asset: string;
  amount: string;
  paid: string;
  outcome: "released" | "returned";
  terms_hash: string;
  at: number;
}

export interface EarnedLimit {
  /** Largest single clause this payee may be offered right now, in base units. */
  limit: string;
  /** Why: still under the new-payee ceiling, or lifted to the per-clause cap by released work. */
  reason: "new_payee_ceiling" | "max_per_clause";
  released: number;
}

/** The factory lifts the new-payee ceiling after the first released clause. */
export function earnedLimit(standing: Standing, mandate: ChainMandate): EarnedLimit {
  const released = standing.as_payee.released;
  if (released > 0) return { limit: mandate.max_per_clause, reason: "max_per_clause", released };
  const ceiling = BigInt(mandate.new_payee_ceiling) < BigInt(mandate.max_per_clause) ? mandate.new_payee_ceiling : mandate.max_per_clause;
  return { limit: ceiling, reason: "new_payee_ceiling", released };
}

export interface LeaderRow {
  payee: string;
  released: number;
  returned: number;
  /** Total paid out to this payee through released clauses, base units. */
  volume: string;
  lastAt: number;
}

/** Ranks payees by released clauses, then by volume, then by most recent. */
export function leaderboard(receipts: ChainReceipt[], limit = 50): LeaderRow[] {
  const rows = new Map<string, { released: number; returned: number; volume: bigint; lastAt: number }>();
  for (const r of receipts) {
    const row = rows.get(r.payee) ?? { released: 0, returned: 0, volume: 0n, lastAt: 0 };
    if (r.outcome === "released") {
      row.released += 1;
      row.volume += BigInt(r.paid);
    } else {
      row.returned += 1;
    }
    row.lastAt = Math.max(row.lastAt, r.at);
    rows.set(r.payee, row);
  }
  return [...rows.entries()]
    .map(([payee, r]) => ({ payee, released: r.released, returned: r.returned, volume: r.volume.toString(), lastAt: r.lastAt }))
    .sort((a, b) => b.released - a.released || (BigInt(b.volume) > BigInt(a.volume) ? 1 : BigInt(b.volume) < BigInt(a.volume) ? -1 : 0) || b.lastAt - a.lastAt)
    .slice(0, limit);
}

/** 6-decimal base units to "12.50". */
export function amount6(base: string): string {
  return (Number(BigInt(base)) / 1e6).toFixed(2);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * A small badge a payee can put on a profile or README. It shows only what the
 * factory recorded; the link next to it lets anyone check.
 */
export function badgeSvg(account: string, standing: Standing, symbol: string): string {
  const p = standing.as_payee;
  const left = "Clausehold";
  const right = p.released > 0 ? `${p.released} paid · ${amount6(p.released_volume)} ${symbol}` : "no paid clauses yet";
  const lw = 7 * left.length + 20;
  const rw = Math.max(90, Math.round(6.6 * right.length) + 20);
  const color = p.released > 0 ? "#2f9e6e" : "#6b6f80";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(`${left}: ${right} for ${account}`)}">
<title>${esc(`${account} on Clausehold: ${p.released} released, ${p.returned} returned`)}</title>
<rect width="${lw}" height="20" rx="3" fill="#1d1b26"/>
<rect x="${lw}" width="${rw}" height="20" rx="3" fill="${color}"/>
<rect x="${lw}" width="4" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
<text x="10" y="14">${left}</text>
<text x="${lw + 10}" y="14">${esc(right)}</text>
</g>
</svg>`;
}
