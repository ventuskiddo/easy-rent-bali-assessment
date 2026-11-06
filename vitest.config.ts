import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/patch/test_concurrency.ts"],
    testTimeout: 30_000,
  },
});
