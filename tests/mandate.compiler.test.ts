import { describe, it, expect } from "vitest";
import { parseCompilerOutput } from "../src/mandate/compiler.js";

const VALID = {
  maxPerClause: 25,
  dailySpendCap: 200,
  perPayeeDailyCap: 50,
  newPayeeCeiling: 10,
  confirmAbove: 15,
  allowedAssets: ["USDC", "USDT"],
};

describe("parseCompilerOutput", () => {
  it("parses valid JSON", () => {
    const result = parseCompilerOutput(JSON.stringify(VALID));
    expect(result.maxPerClause).toBe(25);
    expect(result.confirmAbove).toBe(15);
    expect(result.allowedAssets).toEqual(["USDC", "USDT"]);
  });

  it("strips ```json ... ``` fences", () => {
    const result = parseCompilerOutput("```json\n" + JSON.stringify(VALID) + "\n```");
    expect(result.maxPerClause).toBe(25);
  });

  it("strips bare ``` ... ``` fences without a json tag", () => {
    const result = parseCompilerOutput("```\n" + JSON.stringify(VALID) + "\n```");
    expect(result.maxPerClause).toBe(25);
  });

  it("normalizes explicit nulls on optional fields to undefined", () => {
    const result = parseCompilerOutput(
      JSON.stringify({ ...VALID, allowedPayees: null, blockedPayees: null, maxClausesPerHour: null, maxDeadlineMinutes: null })
    );
    expect(result.allowedPayees).toBeUndefined();
    expect(result.blockedPayees).toBeUndefined();
    expect(result.maxClausesPerHour).toBeUndefined();
    expect(result.maxDeadlineMinutes).toBeUndefined();
  });

  it("keeps the optional limits when given", () => {
    const result = parseCompilerOutput(JSON.stringify({ ...VALID, allowedPayees: ["editor.near"], maxClausesPerHour: 4, maxDeadlineMinutes: 1440 }));
    expect(result).toMatchObject({ allowedPayees: ["editor.near"], maxClausesPerHour: 4, maxDeadlineMinutes: 1440 });
  });

  it("throws on non-JSON output", () => {
    expect(() => parseCompilerOutput("this is not json at all")).toThrow("non-JSON output");
  });

  it("throws listing the Zod issue for a schema violation", () => {
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, maxPerClause: -10 }))).toThrow("failed validation");
  });

  it("refuses an empty asset list, since a mandate must name what may be paid", () => {
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, allowedAssets: [] }))).toThrow("failed validation");
  });

  it("refuses values that make no sense", () => {
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, maxClausesPerHour: 0 }))).toThrow("failed validation");
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, maxClausesPerHour: 2.5 }))).toThrow("failed validation");
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, maxDeadlineMinutes: -5 }))).toThrow("failed validation");
  });

  it("throws when confirmAbove equals maxPerClause", () => {
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, maxPerClause: 15, confirmAbove: 15, newPayeeCeiling: 10 }))).toThrow("must be less than");
  });

  it("throws when confirmAbove exceeds maxPerClause", () => {
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, maxPerClause: 15, confirmAbove: 20, newPayeeCeiling: 10 }))).toThrow("must be less than");
  });

  it("accepts confirmAbove one cent below maxPerClause", () => {
    const result = parseCompilerOutput(JSON.stringify({ ...VALID, maxPerClause: 15, confirmAbove: 14.99, newPayeeCeiling: 10 }));
    expect(result.confirmAbove).toBe(14.99);
  });

  it("throws when the new-payee ceiling is above the per-clause cap", () => {
    expect(() => parseCompilerOutput(JSON.stringify({ ...VALID, newPayeeCeiling: 30 }))).toThrow("newPayeeCeiling");
  });
});
