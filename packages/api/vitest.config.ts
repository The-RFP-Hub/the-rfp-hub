import { defineConfig } from "vitest/config";

// Same cap as the root config, for `vitest run` started from this package: the integration suites
// share one Postgres and fail intermittently with a worker per core.
export default defineConfig({ test: { maxWorkers: 4 } });
