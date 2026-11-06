import { describe, it, expect, vi } from "vitest";
import {
  assertQuoteFundsClause,
  buildClauseFundingQuote,
  findToken,
  nep141ContractId,
  OneClickClient,
  OneClickError,
  waitForFunding,
  type OneClickToken,
  type QuoteResponse,
  type StatusResponse,
} from "../src/near/intents.js";
import { fromBaseUnits, toBaseUnits } from "../src/near/network.js";

const tokens: OneClickToken[] = [
  { assetId: "nep141:usdc.example.near", decimals: 6, blockchain: "near", symbol: "USDC", price: 1, priceUpdatedAt: "" },
  { assetId: "nep141:base-0xusdc.omft.near", decimals: 6, blockchain: "base", symbol: "USDC", price: 1, priceUpdatedAt: "" },
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 3, priceUpdatedAt: "" },
];

const params = {
  originAsset: "nep141:base-0xusdc.omft.near",
  destinationAsset: "nep141:usdc.example.near",
  amountBase: "2000000",
  clauseAccountId: "r-104.clausehold.near",
  refundTo: "0x0000000000000000000000000000000000000001",
  deadline: new Date("2026-11-10T12:00:00Z"),
  dry: false,
};

function quoteResponse(over: Partial<QuoteResponse["quote"]> = {}, recipient = params.clauseAccountId): QuoteResponse {
  const req = buildClauseFundingQuote(params);
  return {
    correlationId: "c",
    timestamp: "",
    signature: "s",
    quoteRequest: { ...req, recipient },
    quote: {
      depositAddress: "0xdeposit",
      amountIn: "2010000",
      amountInFormatted: "2.01",
      amountInUsd: "2.01",
      minAmountIn: "2010000",
      amountOut: "2000000",
      amountOutFormatted: "2",
      amountOutUsd: "2",
      minAmountOut: "2000000",
      timeEstimate: 20,
      ...over,
    },
  };
}

describe("units", () => {
  it("converts decimal amounts to base units exactly", () => {
    expect(toBaseUnits("2", 6)).toBe("2000000");
    expect(toBaseUnits(0.1, 6)).toBe("100000");
    expect(toBaseUnits("0.000001", 6)).toBe("1");
    expect(fromBaseUnits("2000000", 6)).toBe("2");
    expect(fromBaseUnits("2500001", 6)).toBe("2.500001");
  });

  it("refuses more precision than the token has, rather than rounding money", () => {
    expect(() => toBaseUnits("0.0000001", 6)).toThrow(/decimal places/);
    expect(() => toBaseUnits("-1", 6)).toThrow();
    expect(() => toBaseUnits("1e3", 6)).toThrow();
  });
});

describe("findToken and nep141ContractId", () => {
  it("finds USDC on NEAR from the token list, not a lookalike on another chain", () => {
    const t = findToken(tokens, "near", "usdc");
    expect(t.assetId).toBe("nep141:usdc.example.near");
    expect(nep141ContractId(t.assetId)).toBe("usdc.example.near");
  });

  it("refuses a missing or ambiguous token", () => {
    expect(() => findToken(tokens, "near", "USDT")).toThrow(/no USDT/);
    expect(() => findToken([...tokens, { ...tokens[0]!, assetId: "nep141:other.near" }], "near", "USDC")).toThrow(/2 tokens/);
  });

  it("refuses a non-NEP-141 asset id", () => {
    expect(() => nep141ContractId("nep245:x")).toThrow();
  });
});

describe("buildClauseFundingQuote", () => {
  it("asks for exactly the clause amount, delivered on chain to the clause account", () => {
    const q = buildClauseFundingQuote(params);
    expect(q).toMatchObject({
      swapType: "EXACT_OUTPUT",
      recipientType: "DESTINATION_CHAIN",
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipient: "r-104.clausehold.near",
      amount: "2000000",
      deadline: "2026-11-10T12:00:00.000Z",
    });
  });

  it("refuses a decimal or zero amount", () => {
    expect(() => buildClauseFundingQuote({ ...params, amountBase: "2.0" })).toThrow();
    expect(() => buildClauseFundingQuote({ ...params, amountBase: "0" })).toThrow();
  });
});

describe("assertQuoteFundsClause", () => {
  const req = buildClauseFundingQuote(params);

  it("accepts a quote that delivers the full amount to the clause", () => {
    expect(() => assertQuoteFundsClause(quoteResponse(), req)).not.toThrow();
  });

  it("refuses a quote that would leave the clause short", () => {
    expect(() => assertQuoteFundsClause(quoteResponse({ amountOut: "1990000", minAmountOut: "1990000" }), req)).toThrow(/less than the clause amount/);
    expect(() => assertQuoteFundsClause(quoteResponse({ minAmountOut: "1999999" }), req)).toThrow(/less than the clause amount/);
  });

  it("refuses a quote addressed anywhere else", () => {
    expect(() => assertQuoteFundsClause(quoteResponse({}, "attacker.near"), req)).toThrow(/not the clause account/);
  });

  it("refuses a live quote with no deposit address", () => {
    expect(() => assertQuoteFundsClause(quoteResponse({ depositAddress: undefined }), req)).toThrow(/deposit address/);
  });
});

describe("OneClickClient", () => {
  it("sends the quote as JSON with the partner key header when given", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(quoteResponse()), { status: 200 }));
    const client = new OneClickClient({ apiKey: "jwt", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.quote(buildClauseFundingQuote(params));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("jwt");
    expect(JSON.parse(init.body as string).recipient).toBe("r-104.clausehold.near");
  });

  it("surfaces the API's error message", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "amount too low" }), { status: 400 }));
    const client = new OneClickClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.tokens()).rejects.toThrow(new OneClickError(400, "amount too low"));
  });

  it("polls status until a terminal state", async () => {
    const seq: StatusResponse["status"][] = ["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: seq.shift(), swapDetails: {} }), { status: 200 }));
    const client = new OneClickClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const seen: string[] = [];
    const final = await waitForFunding(client, "0xdeposit", { sleep: async () => {}, onUpdate: (s) => seen.push(s.status) });
    expect(final.status).toBe("SUCCESS");
    expect(seen).toEqual(["PENDING_DEPOSIT", "PROCESSING", "SUCCESS"]);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toContain("/status?depositAddress=0xdeposit");
  });
});
