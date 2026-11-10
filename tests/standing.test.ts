import { describe, expect, it } from "vitest";
import { badgeSvg, earnedLimit, leaderboard, type ChainMandate, type ChainReceipt } from "../src/api/standing.js";
import type { Standing } from "../src/near/standing.js";

const mandate: ChainMandate = {
  allowed_assets: ["musd.clausehold.testnet"],
  max_per_clause: "25000000",
  per_payee_daily_cap: "50000000",
  daily_cap: "200000000",
  new_payee_ceiling: "10000000",
  paused: false,
  cosigner: null,
};

function standing(released: number, returned = 0, volume = "0"): Standing {
  return {
    as_payee: { open: 0, released, returned, released_volume: volume },
    as_buyer: { open: 0, released: 0, returned: 0, released_volume: "0" },
  };
}

function receipt(payee: string, outcome: "released" | "returned", paid: string, at: number): ChainReceipt {
  return { clause_id: at, account_id: `r-${at}.clausehold.testnet`, buyer: "b.testnet", payee, asset: "musd.clausehold.testnet", amount: paid, paid, outcome, terms_hash: "h", at };
}

describe("earnedLimit", () => {
  it("keeps a payee with nothing released under the new-payee ceiling", () => {
    expect(earnedLimit(standing(0, 2), mandate)).toEqual({ limit: "10000000", reason: "new_payee_ceiling", released: 0 });
  });

  it("lifts the limit to the per-clause cap after one released clause", () => {
    expect(earnedLimit(standing(1), mandate)).toEqual({ limit: "25000000", reason: "max_per_clause", released: 1 });
  });

  it("never offers more than the per-clause cap, even if the ceiling is set higher", () => {
    expect(earnedLimit(standing(0), { ...mandate, new_payee_ceiling: "99000000" }).limit).toBe("25000000");
  });
});

describe("leaderboard", () => {
  it("ranks by released clauses, then volume, and counts returns separately", () => {
    const rows = leaderboard([
      receipt("a.testnet", "released", "2000000", 1),
      receipt("b.testnet", "released", "5000000", 2),
      receipt("a.testnet", "released", "1000000", 3),
      receipt("b.testnet", "returned", "5000000", 4),
      receipt("c.testnet", "returned", "1000000", 5),
    ]);
    expect(rows.map((r) => r.payee)).toEqual(["a.testnet", "b.testnet", "c.testnet"]);
    expect(rows[0]).toMatchObject({ released: 2, returned: 0, volume: "3000000", lastAt: 3 });
    expect(rows[1]).toMatchObject({ released: 1, returned: 1, volume: "5000000" });
    expect(rows[2]).toMatchObject({ released: 0, returned: 1, volume: "0" });
  });
});

describe("badgeSvg", () => {
  it("shows paid clauses and volume, and escapes the account name", () => {
    const svg = badgeSvg("x<y>.testnet", standing(3, 1, "6000000"), "mUSD");
    expect(svg).toContain("3 paid · 6.00 mUSD");
    expect(svg).toContain("x&lt;y&gt;.testnet");
    expect(svg).not.toContain("x<y>");
  });

  it("says so plainly when nothing has been paid yet", () => {
    expect(badgeSvg("new.testnet", standing(0), "mUSD")).toContain("no paid clauses yet");
  });
});
