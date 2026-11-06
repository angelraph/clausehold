import { describe, it, expect } from "vitest";
import { ClauseProposalSchema } from "../src/policy/types.js";

const now = Date.now();
const base = {
  id: "00000000-0000-0000-0000-000000000002",
  agentId: "studio-agent",
  mandateId: "00000000-0000-0000-0000-000000000001",
  buyer: "studio.testnet",
  payee: "editor.testnet",
  asset: "USDC",
  amount: 2,
  terms: "Cut intro.mp4 to 30 seconds",
  deadline: new Date(now + 15 * 60_000).toISOString(),
  submittedAt: new Date(now).toISOString(),
};

describe("ClauseProposalSchema", () => {
  it("accepts a well-formed clause and defaults the challenge window to 0", () => {
    const r = ClauseProposalSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.success && r.data.challengeSecs).toBe(0);
  });

  it("refuses a deadline at or before submission", () => {
    expect(ClauseProposalSchema.safeParse({ ...base, deadline: base.submittedAt }).success).toBe(false);
  });

  it("refuses paying yourself", () => {
    expect(ClauseProposalSchema.safeParse({ ...base, payee: base.buyer }).success).toBe(false);
  });

  it("refuses a zero or negative amount", () => {
    expect(ClauseProposalSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(ClauseProposalSchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
  });

  it("refuses empty terms and a negative or fractional challenge window", () => {
    expect(ClauseProposalSchema.safeParse({ ...base, terms: "" }).success).toBe(false);
    expect(ClauseProposalSchema.safeParse({ ...base, challengeSecs: -1 }).success).toBe(false);
    expect(ClauseProposalSchema.safeParse({ ...base, challengeSecs: 1.5 }).success).toBe(false);
  });
});
