import { MandateSchema, type Mandate } from "./schema.js";
import type { KvBackend } from "../storage/backends.js";
import { defaultKvBackend } from "../storage/index.js";
import { config } from "../config.js";
import demoMandate from "./examples/demo-mandate.json" with { type: "json" };

export class MandateNotFoundError extends Error {
  constructor(public readonly mandateId: string) {
    super(`No mandate found with id ${mandateId}`);
    this.name = "MandateNotFoundError";
  }
}

let override: KvBackend | undefined;

/** For tests: use a specific backend instead of the configured one. */
export function setMandateBackend(b: KvBackend | undefined): void {
  override = b;
}

function backend(): KvBackend {
  return override ?? defaultKvBackend();
}

/**
 * The demo mandate, pointed at this network's factory. A freshly hosted desk
 * starts with an empty database; with CLAUSEHOLD_SEED_DEMO_MANDATE=true it
 * stores this on first use, so the desk works without a separate setup step.
 */
export function demoMandateFor(factoryAccountId: string): Mandate {
  return MandateSchema.parse({ ...demoMandate, factoryAccountId });
}

export async function loadMandate(id: string): Promise<Mandate> {
  const raw = await backend().get(id);
  if (raw === null) {
    if (config.seedDemoMandate && id === demoMandate.id) {
      const seeded = demoMandateFor(config.factoryAccountId);
      await saveMandate(seeded);
      return seeded;
    }
    throw new MandateNotFoundError(id);
  }
  return MandateSchema.parse(JSON.parse(raw));
}

export async function saveMandate(mandate: Mandate): Promise<void> {
  await backend().set(mandate.id, JSON.stringify(mandate, null, 2));
}
