import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MandateSchema } from "../../mandate/schema.js";
import { saveMandate } from "../../mandate/store.js";
import { auditLog } from "../../audit/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Seeds the demo mandate from src/mandate/examples/demo-mandate.json. */
export async function initCommand(): Promise<void> {
  const examplePath = path.join(__dirname, "../../mandate/examples/demo-mandate.json");
  const raw = JSON.parse(await readFile(examplePath, "utf-8"));
  const mandate = MandateSchema.parse(raw);

  await saveMandate(mandate);
  await auditLog.append("MANDATE_CREATED", "n/a", { mandateId: mandate.id, source: "demo-mandate.json", limits: mandate.limits });

  const l = mandate.limits;
  console.log(`Mandate ${mandate.id} activated for ${mandate.factoryAccountId}.`);
  console.log(`  Rule: "${mandate.naturalLanguageSource}"`);
  console.log(`  Max per clause: ${l.maxPerClause}   confirm above: ${l.confirmAbove}`);
  console.log(`  Per payee per day: ${l.perPayeeDailyCap}   all payees per day: ${l.dailySpendCap}`);
  console.log(`  New payee ceiling: ${l.newPayeeCeiling}   assets: ${l.allowedAssets.join(", ")}`);
}
