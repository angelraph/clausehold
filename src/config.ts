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
  /** The account that pays gas for gasless deliveries. Its key lives only in .env. */
  relayer: z.object({
    accountId: z.string().optional(),
    privateKey: z.string().optional(),
  }),
  /**
   * Who signs create_clause. "server": the service account writes cleared
   * clauses and pays the deposit (agents and local runs). "wallet": the
   * buyer's own wallet signs and pays, and the desk only checks the result
   * on chain. Hosted desks use "wallet", so the desk never spends for strangers.
   */
  clauseWriter: z.enum(["server", "wallet"]),
  /** Read each payee's earned standing from the factory before checking a clause. Off in tests. */
  chainStanding: z.boolean(),
  /** NEAR Intents 1Click partner key. Optional: without it 1Click adds a 0.25% fee. */
  intentsApiKey: z.string().optional(),
  /** Browser origins allowed to call the API, e.g. the deployed web app. */
  webOrigins: z.array(z.string()),
  apiPort: z.coerce.number().int().positive(),
  apiKey: z.string().optional(),
  approverKey: z.string().optional(),
  requireAgentKeys: z.boolean(),
  approvalTtlMinutes: z.coerce.number().positive(),
  auditLogPath: z.string(),
  mandatesDir: z.string(),
  /** Store the demo mandate on first use when the database is empty (hosted desks). */
  seedDemoMandate: z.boolean(),
  /** Upstash Redis for serverless hosting. When unset, records are kept in files. */
  storage: z.object({
    upstashUrl: z.string().url().optional(),
    upstashToken: z.string().optional(),
    /** Keeps testnet and mainnet records apart when they share one database. */
    prefix: z.string().min(1),
  }),
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
    relayer: {
      accountId: process.env.CLAUSEHOLD_RELAYER_ACCOUNT || undefined,
      privateKey: process.env.CLAUSEHOLD_RELAYER_PRIVATE_KEY || undefined,
    },
    clauseWriter: process.env.CLAUSEHOLD_CLAUSE_WRITER === "wallet" ? "wallet" : "server",
    chainStanding: process.env.CLAUSEHOLD_CHAIN_STANDING !== "off",
    intentsApiKey: process.env.NEAR_INTENTS_API_KEY || undefined,
    webOrigins: (process.env.CLAUSEHOLD_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((o) => o.trim()).filter(Boolean),
    apiPort: process.env.CLAUSEHOLD_API_PORT ?? 4477,
    apiKey: process.env.CLAUSEHOLD_API_KEY || undefined,
    approverKey: process.env.CLAUSEHOLD_APPROVER_KEY || undefined,
    requireAgentKeys: process.env.CLAUSEHOLD_REQUIRE_AGENT_KEYS === "true",
    approvalTtlMinutes: process.env.CLAUSEHOLD_APPROVAL_TTL_MINUTES ?? 10,
    auditLogPath: process.env.CLAUSEHOLD_AUDIT_LOG_PATH ?? "./data/audit.log.jsonl",
    mandatesDir: process.env.CLAUSEHOLD_MANDATES_DIR ?? "./data/mandates",
    seedDemoMandate: process.env.CLAUSEHOLD_SEED_DEMO_MANDATE === "true",
    storage: {
      // Vercel's Upstash integration names these KV_REST_API_*; Upstash itself uses UPSTASH_REDIS_REST_*.
      upstashUrl: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || undefined,
      upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || undefined,
      prefix: process.env.CLAUSEHOLD_STORE_PREFIX ?? `clausehold:${network}`,
    },
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
