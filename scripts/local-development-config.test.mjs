/**
 * The two copy-and-run local env files describe one connection. A mismatched port leaves the
 * frontend healthy enough to render but unable to load data or sign in, which is a particularly
 * expensive first-run failure.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function source(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function envValue(relativePath, name) {
  const contents = source(relativePath);
  const match = new RegExp(`^${name}=(.+)$`, "m").exec(contents);
  if (!match?.[1]) throw new Error(`${name} is missing from ${relativePath}`);
  return match[1].trim();
}

describe("the documented local frontend/API connection", () => {
  it("points the frontend env example at the API env example's port", () => {
    const apiPort = envValue("packages/api/.env-example", "PORT");
    const frontendApi = new URL(envValue("packages/frontend/.env-example", "NEXT_PUBLIC_API_URL"));

    expect(frontendApi.hostname).toBe("localhost");
    expect(frontendApi.port).toBe(apiPort);
    expect(source("packages/frontend/README.md")).toContain(`http://localhost:${apiPort}`);
  });

  it("keeps the API bootstrap runnable from the repository root", () => {
    const readme = source("packages/api/README.md");
    const compose = "docker compose -f packages/api/docker-compose.yml up -d";
    const copyEnv = "cp packages/api/.env-example packages/api/.env";
    const migrate = "pnpm --filter @the-rfp-hub/api migrate";
    const seed = "pnpm --filter @the-rfp-hub/api seed";
    const backfill = "pnpm --filter @the-rfp-hub/api jobs embedding-backfill";
    const start = "pnpm --filter @the-rfp-hub/api dev";

    for (const command of [compose, copyEnv, migrate, seed, backfill, start]) {
      expect(readme).toContain(command);
    }
    expect(readme.indexOf(migrate)).toBeLessThan(readme.indexOf(seed));
    expect(readme.indexOf(seed)).toBeLessThan(readme.indexOf(backfill));
    expect(readme.indexOf(backfill)).toBeLessThan(readme.indexOf(start));
    expect(readme).toContain("remaining=0");
  });
});
