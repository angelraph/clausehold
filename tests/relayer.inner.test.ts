import { describe, expect, it } from "vitest";
import { innerFailure } from "../src/near/relayer.js";

const CLAUSE = "r-8.clausehold.testnet";

/** What NEAR returns for a meta-transaction whose inner call panicked: the outer status is fine. */
function outcome(innerPanic: string | null) {
  return {
    status: { SuccessValue: "" },
    transaction: { hash: "TxHash111" },
    receipts_outcome: [
      { outcome: { executor_id: CLAUSE, status: { SuccessReceiptId: "a" } } },
      {
        outcome: {
          executor_id: CLAUSE,
          status: innerPanic
            ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${innerPanic}` } } } } }
            : { SuccessValue: "dHJ1ZQ==" },
        },
      },
      { outcome: { executor_id: "musd.clausehold.testnet", status: { Failure: { ActionError: { kind: "token side, handled by the clause" } } } } },
    ],
  };
}

describe("innerFailure", () => {
  it("finds a panic in the call the clause ran, even when the outer status is a success", () => {
    expect(JSON.stringify(innerFailure(outcome("DEADLINE_PASSED"), CLAUSE))).toContain("DEADLINE_PASSED");
  });

  it("ignores failures on other accounts, which the clause handles in its callbacks", () => {
    expect(innerFailure(outcome(null), CLAUSE)).toBeUndefined();
  });
});
