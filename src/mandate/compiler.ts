import OpenAI from "openai";
import { MandateLimitsSchema, type MandateLimits } from "./schema.js";
import { config } from "../config.js";

const SYSTEM_PROMPT = `You compile a treasury's plain-English payment rule into a strict JSON policy object.
The policy governs clauses: payments held in a NEAR sub-account until a job is delivered, then released to the payee or returned to the buyer.
Output ONLY a JSON object (no markdown fences, no commentary) with exactly these fields. Amounts are in stablecoin units (USD):
{
  "maxPerClause": number,          // hard cap on one clause; nothing above this is ever written, confirmed or not
  "dailySpendCap": number,         // max total value of clauses written in one UTC day
  "perPayeeDailyCap": number,      // max total value to any single payee in one UTC day
  "newPayeeCeiling": number,       // most a payee who has never been paid through a released clause may be offered
  "confirmAbove": number,          // clauses above this, but under maxPerClause, need a second person to approve
  "allowedAssets": string[],       // asset symbols, e.g. ["USDC","USDT"]; default ["USDC"] if none are named
  "allowedPayees": string[] | null,  // NEAR account ids, or null if unrestricted
  "blockedPayees": string[] | null,
  "maxClausesPerHour": number | null,   // most clauses one agent may write in any rolling hour (whole number)
  "maxDeadlineMinutes": number | null   // longest a clause may stay open before it expires and returns
}
IMPORTANT: confirmAbove must always be strictly less than maxPerClause, otherwise no clause could ever need confirmation
without already being blocked by the hard cap. newPayeeCeiling must not exceed maxPerClause.
Be conservative: if the rule doesn't mention a limit, pick a sensible strict default rather than an unlimited one
(e.g. if only maxPerClause is stated, set confirmAbove to roughly a third of it, newPayeeCeiling to roughly half of it,
perPayeeDailyCap to twice it and dailySpendCap to ten times it).
Set allowedPayees, blockedPayees, maxClausesPerHour and maxDeadlineMinutes to null unless the rule asks for that kind of limit. Do not invent them.`;

/**
 * Pure parse/normalize/validate step, factored out of compileMandateFromText
 * so it's unit-testable without a live model call. Strips markdown code
 * fences first, since models occasionally wrap JSON in them despite the
 * system prompt saying not to.
 */
export function parseCompilerOutput(rawText: string): MandateLimits {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Mandate compiler returned non-JSON output:\n${rawText}`);
  }

  // Normalize explicit nulls to undefined for the optional-field schema.
  const normalized = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, v === null ? undefined : v])
  );

  const result = MandateLimitsSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(
      `Mandate compiler output failed validation. Refusing to activate an unsafe policy:\n` +
        result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n") +
        `\n\nRaw output:\n${rawText}`
    );
  }

  // Belt-and-braces: the prompt asks for confirmAbove < maxPerClause, but
  // a model can ignore instructions. Enforce it in code rather than trusting
  // the prompt alone, since a violation here silently makes the ESCALATE
  // verdict unreachable (see policy/rules/confirmAboveX.ts).
  if (result.data.confirmAbove >= result.data.maxPerClause) {
    throw new Error(
      `Mandate compiler output is inconsistent: confirmAbove (${result.data.confirmAbove}) must be less than ` +
        `maxPerClause (${result.data.maxPerClause}), otherwise no clause could ever need confirmation without ` +
        `already being blocked by the hard cap. Refusing to activate this policy.`
    );
  }
  if (result.data.newPayeeCeiling > result.data.maxPerClause) {
    throw new Error(
      `Mandate compiler output is inconsistent: newPayeeCeiling (${result.data.newPayeeCeiling}) is above ` +
        `maxPerClause (${result.data.maxPerClause}). Refusing to activate this policy.`
    );
  }

  return result.data;
}

/**
 * Compiles a free-text rule into draft MandateLimits via NEAR AI Cloud
 * (an OpenAI-compatible endpoint).
 * Always re-validated through MandateLimitsSchema before it's ever shown to
 * the operator, so a malformed or out-of-range model response fails loudly
 * here rather than silently becoming a live policy.
 */
export async function compileMandateFromText(covenantText: string): Promise<MandateLimits> {
  if (!config.nearAi.apiKey || !config.nearAi.model) {
    throw new Error(
      "NEARAI_API_KEY and NEARAI_MODEL must be set to use the plain-English mandate compiler. " +
        "Edit a mandate JSON file directly under data/mandates/ instead (see src/mandate/examples/demo-mandate.json for the shape)."
    );
  }

  const client = new OpenAI({ apiKey: config.nearAi.apiKey, baseURL: config.nearAi.baseUrl });
  const response = await client.chat.completions.create({
    model: config.nearAi.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: covenantText },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error("Mandate compiler received no text response from the model");
  }

  return parseCompilerOutput(text);
}
