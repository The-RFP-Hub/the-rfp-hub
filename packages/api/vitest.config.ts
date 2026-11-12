import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: ["test/integration/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "api-integration",
          include: ["test/integration/**/*.test.ts"],
          // Match the root run: global sweeps must not mutate another suite's fixtures.
          fileParallelism: false,
        },
      },
    ],
  },
});
