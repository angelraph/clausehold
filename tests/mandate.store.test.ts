import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { loadMandate, saveMandate, MandateNotFoundError } from "../src/mandate/store.js";
import type { Mandate } from "../src/mandate/schema.js";

let dir: string;
let originalMandatesDir: string;

function makeMandate(): Mandate {
  return {
    id: "00000000-0000-0000-0000-000000000099",
    version: 1,
    owner: "test",
    createdAt: new Date().toISOString(),
    factoryAccountId: "clausehold.testnet",
    naturalLanguageSource: "test mandate",
    status: "active",
    limits: {
      maxPerClause: 50,
      dailySpendCap: 500,
      perPayeeDailyCap: 100,
      newPayeeCeiling: 20,
      confirmAbove: 20,
      allowedAssets: ["USDC"],
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clausehold-mandate-store-test-"));
  originalMandatesDir = config.mandatesDir;
  config.mandatesDir = dir;
});

afterEach(() => {
  config.mandatesDir = originalMandatesDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadMandate", () => {
  it("throws MandateNotFoundError for a missing id", async () => {
    await expect(loadMandate("does-not-exist")).rejects.toBeInstanceOf(MandateNotFoundError);
  });

  it("MandateNotFoundError carries the requested id", async () => {
    try {
      await loadMandate("does-not-exist");
      expect.unreachable("expected loadMandate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MandateNotFoundError);
      expect((err as MandateNotFoundError).mandateId).toBe("does-not-exist");
    }
  });

  it("throws a plain Error, not MandateNotFoundError, for malformed JSON", async () => {
    writeFileSync(path.join(dir, "broken.json"), "{ not valid json", "utf-8");
    await expect(loadMandate("broken")).rejects.not.toBeInstanceOf(MandateNotFoundError);
    await expect(loadMandate("broken")).rejects.toThrow();
  });

  it("round-trips a saved mandate", async () => {
    const mandate = makeMandate();
    await saveMandate(mandate);
    const loaded = await loadMandate(mandate.id);
    expect(loaded).toEqual(mandate);
  });
});

describe("demo mandate seeding", () => {
  it("stores the demo mandate on first use when seeding is on, pointed at this network's factory", async () => {
    const before = config.seedDemoMandate;
    config.seedDemoMandate = true;
    try {
      const m = await loadMandate("b2f1e9a0-1a2b-4c3d-8e4f-000000000001");
      expect(m.factoryAccountId).toBe(config.factoryAccountId);
      expect(m.limits.maxPerClause).toBe(25);
      // It is now really stored, not just returned.
      config.seedDemoMandate = false;
      expect((await loadMandate(m.id)).id).toBe(m.id);
    } finally {
      config.seedDemoMandate = before;
    }
  });

  it("does not invent a mandate when seeding is off", async () => {
    await expect(loadMandate("b2f1e9a0-1a2b-4c3d-8e4f-000000000001")).rejects.toBeInstanceOf(MandateNotFoundError);
  });
});
