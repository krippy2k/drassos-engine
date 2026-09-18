import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "examples/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: true,
    maxWorkers: 4,
    reporters: ["default"],
  },
});
