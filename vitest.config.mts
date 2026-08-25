import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      include: ["dist/**/*.mjs"],
      reporter: ["text"],
      thresholds: { 100: true, perFile: true },
    },
  },
});
