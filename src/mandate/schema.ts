import { z } from "zod";

/**
 * A Mandate is the machine-enforceable form of a treasury's plain-English
 * rule ("stablecoins only, at most $50 to any one payee a day, a new payee
 * gets at most $10 until they have delivered once"). It is set once. After
 * that, no one votes per invoice: a clause either fits the mandate or is
 * refused before anyone signs. Amounts are in stablecoin units (USD).
 */
export const MandateLimitsSchema = z.object({
  /** Hard cap on one clause. Nothing above it is ever written, confirmed or not. */
  maxPerClause: z.number().positive(),
  /** Total value of clauses cleared in one UTC day, across all payees. */
  dailySpendCap: z.number().positive(),
  /** Total value of clauses cleared to one payee in one UTC day. */
  perPayeeDailyCap: z.number().positive(),
  /** Most a payee with no released clause yet may be offered. */
  newPayeeCeiling: z.number().positive(),
  /** Clauses above this need a second person before they are written. Must be below maxPerClause. */
  confirmAbove: z.number().positive(),
  /** Asset symbols a clause may be paid in, e.g. ["USDC", "USDT"]. */
  allowedAssets: z.array(z.string().min(1)).min(1),
  allowedPayees: z.array(z.string()).optional(),
  blockedPayees: z.array(z.string()).optional(),
  /** Most clauses one agent may have cleared in any rolling hour. */
  maxClausesPerHour: z.number().int().positive().optional(),
  /** Longest a clause may stay open before it expires and returns. */
  maxDeadlineMinutes: z.number().positive().optional(),
});

export const MandateSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  /** Who set the mandate: a person, or the DAO account that voted it in. */
  owner: z.string().min(1),
  createdAt: z.string().datetime(),
  /** The factory contract the mandate governs, e.g. clausehold.testnet. */
  factoryAccountId: z.string().min(1),
  naturalLanguageSource: z.string().min(1),
  limits: MandateLimitsSchema,
  status: z.enum(["draft", "active", "suspended"]),
});

export type MandateLimits = z.infer<typeof MandateLimitsSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
