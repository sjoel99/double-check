import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts", "apps/api/test/**/*.test.ts"],
    testTimeout: 30_000,
    pool: "forks",
  },
});
