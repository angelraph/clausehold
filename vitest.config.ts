import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Some tests start a real HTTP server and generate keys; slower machines need the headroom.
    testTimeout: 20_000,
  },
});
