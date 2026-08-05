/**
 * Shared DATABASE_URL gate for the integration suites.
 *
 * `describeWithDb` is vitest's `describe` when a database is configured and `describe.skip`
 * otherwise — but the skip is LOUD: a silent `describe.skip` hid the fact that all DB-backed
 * integration tests were not running at all. The warning is emitted once per worker process
 * (vitest isolates test files, so it can appear once per gated file in the default pool).
 */
import { describe } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

const FLAG = "__rfphubDbSkipWarned";
const flags = globalThis as typeof globalThis & { [FLAG]?: boolean };

if (!hasDb && !flags[FLAG]) {
  flags[FLAG] = true;
  console.warn(
    [
      "DATABASE_URL is not set — SKIPPING the DB-backed integration tests (unit tests still run).",
      "To run them against a throwaway Postgres (from packages/api):",
      "  docker compose -f docker-compose.test.yml up -d",
      "  DATABASE_URL=postgres://rfphub:rfphub@localhost:5439/rfphub pnpm run migrate",
      "  DATABASE_URL=postgres://rfphub:rfphub@localhost:5439/rfphub npx vitest run test/integration",
      "  docker compose -f docker-compose.test.yml down",
    ].join("\n"),
  );
}

// Annotated (and skip cast) so the export's type is nameable without deep vitest internals.
export const describeWithDb: typeof describe = hasDb
  ? describe
  : (describe.skip as typeof describe);
