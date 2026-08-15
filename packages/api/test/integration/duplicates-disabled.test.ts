/**
 * The DEGRADED half of duplicate detection: a deployment with no embedding provider.
 *
 * Isolation tag: `M3DUP` / `m3dupoff:`.
 *
 * A SEPARATE FILE, not a separate test. `config.ts` reads the environment once at module load and
 * the submissions controller builds its `DedupeService` from it at module scope, so "provider on"
 * and "provider off" cannot coexist in one module registry. Vitest isolates test files, so the split
 * is the mechanism rather than a stylistic choice — and the env is set before the dynamic imports
 * below because a static `import` is hoisted above every statement in the file.
 *
 * WHAT THIS PROVES, and it is the whole point of `duplicateCheck` being in the response: a
 * deployment with detection off still accepts submissions, still returns 201, and SAYS SO. Without
 * the field, "disabled" and "checked, found nothing" are the same empty array, and a publisher would
 * read the second when the truth is the first.
 */
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.OPENAI_API_KEY = "";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ALPHA_BODY, reword } from "../helpers/dedupe-text.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

// EVERY import that can reach `config.ts` is dynamic, the test helpers included: they import the db
// client, which imports the config, which reads the environment exactly once. A static import of any
// of them would be evaluated before the assignments above and this suite would silently run with
// whatever provider the outer environment configured.
const { buildApp } = await import("../../src/app.js");
const { pool } = await import("../../src/db/client.js");
const { config } = await import("../../src/config.js");
const { bearer, grantMembership, mintPrivyToken, seedAccount, seedOrganization, testPrivyConfig } =
  await import("../helpers/auth.js");
const { cleanupFixtures } = await import("../helpers/cleanup.js");

const NS = "m3dupoff";
const DIDS = { publisher: "did:privy:m3dupoff-publisher" };

const run = describeWithDb;

function entry(id: string, title: string, body: string) {
  return submission(id, NS, {
    title,
    // The body goes in `description` only: the Standard caps `summary` at 500 characters, and
    // `embeddingText` falls back to a truncated description when there is no summary — which is
    // the path a real long-form entry takes anyway.
    description: body,
    ecosystems: ["M3DUPOFF"],
  } as Record<string, unknown>);
}

run("M3DUP duplicate detection, provider disabled", () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();
    const publisher = await seedAccount({ did: DIDS.publisher, handle: "m3dupoff-publisher" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.id, org.id, "owner");
    token = await mintPrivyToken(DIDS.publisher);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      privyDids: Object.values(DIDS),
    });
    await app.close();
    await pool.end();
  });

  it("resolves to `disabled` rather than falling back to the deterministic provider", () => {
    // The fallback would be worse than nothing: a deployment reporting duplicate checks it is not
    // really performing. `readEmbeddingProvider` never chooses `deterministic` on its own.
    expect(config.embedding.provider).toBe("disabled");
  });

  it("still stores the submission, and says the check did not run", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: entry(`${NS}:one`, "Superchain Builders Fund", ALPHA_BODY),
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().duplicateCheck).toBe("disabled");
    expect(first.json().duplicates).toEqual([]);

    // An obvious near-copy is still not reported — there is nothing to report it with, and the
    // response says which of the two situations this is.
    const second = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: entry(`${NS}:two`, "Superchain Builders Fund | Mirror", reword(ALPHA_BODY)),
    });
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().duplicateCheck).toBe("disabled");
    expect(second.json().duplicates).toEqual([]);
    // …and the entry is public, which is the property that matters: detection is never a gate.
    expect((await app.inject({ url: `/v1/opportunities/${NS}:two` })).statusCode).toBe(200);
  });
});
