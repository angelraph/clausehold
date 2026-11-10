import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Some tests start a real HTTP server and generate keys; slower machines need the headroom.
    testTimeout: 20_000,
    // Tests never reach the chain; standing comes from the audit log they set up.
    env: { CLAUSEHOLD_CHAIN_STANDING: "off" },
  },
});
