import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  /** Which NEAR network clauses are written to. Intents funding exists on mainnet only. */
  network: z.enum(["testnet", "mainnet"]),
  /** The factory contract that creates one sub-account per clause, e.g. clausehold.testnet. */
  factoryAccountId: z.string().min(2),
  /** Optional RPC override. Defaults per network live in src/near/network.ts. */
  nearRpcUrl: z.string().url().optional(),
  /** NEAR AI Cloud (OpenAI-compatible). Used for the mandate compiler and delivery notes, never to authorize money. */
  nearAi: z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url(),
    model: z.string().optional(),
  }),
  apiPort: z.coerce.number().int().positive(),
  apiKey: z.string().optional(),
  approverKey: z.string().optional(),
  requireAgentKeys: z.boolean(),
  approvalTtlMinutes: z.coerce.number().positive(),
  auditLogPath: z.string(),
  mandatesDir: z.string(),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const network = process.env.CLAUSEHOLD_NETWORK ?? "testnet";
  const raw = {
    network,
    factoryAccountId: process.env.CLAUSEHOLD_FACTORY_ACCOUNT ?? (network === "mainnet" ? "clausehold.near" : "clausehold.testnet"),
    nearRpcUrl: process.env.CLAUSEHOLD_NEAR_RPC_URL || undefined,
    nearAi: {
      apiKey: process.env.NEARAI_API_KEY || undefined,
      baseUrl: process.env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1",
      model: process.env.NEARAI_MODEL || undefined,
    },
    apiPort: process.env.CLAUSEHOLD_API_PORT ?? 4477,
    apiKey: process.env.CLAUSEHOLD_API_KEY || undefined,
    approverKey: process.env.CLAUSEHOLD_APPROVER_KEY || undefined,
    requireAgentKeys: process.env.CLAUSEHOLD_REQUIRE_AGENT_KEYS === "true",
    approvalTtlMinutes: process.env.CLAUSEHOLD_APPROVAL_TTL_MINUTES ?? 10,
    auditLogPath: process.env.CLAUSEHOLD_AUDIT_LOG_PATH ?? "./data/audit.log.jsonl",
    mandatesDir: process.env.CLAUSEHOLD_MANDATES_DIR ?? "./data/mandates",
  };

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid configuration:\n" + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
    process.exit(1);
  }

  // No credential checks here on purpose. config.ts is imported by the audit
  // log, the mandate store and the unit tests. A missing key fails loudly when
  // something actually uses it, not when a file merely imports config.
  return parsed.data;
}

export const config = loadConfig();
