/**
 * The replace-time operating-org containment gate and its narrow, IMPORT-PROVENANCE-SCOPED
 * exemption.
 *
 * A replacement may not strip out the operating organisation that authorises an entry. The one
 * exemption grandfathers rows that BOTH entered through a legacy ingest route
 * (`ingestedVia ∈ {import, scrape, outbox}`) AND never conformed — their stored publisher was never
 * one of their operating orgs. The seed corpus carries 14 such records (published under a namespace
 * that does not run the programme), and enforcing containment on edit would lock them out of
 * ordinary corrections.
 *
 * The exemption is deliberately NOT "any non-conforming row": a row created through the
 * authenticated write path (`publisher_api`/`submission`) went through the create-time gate, so a
 * foreign-operated one of those must still be rejected on replace. Both directions are proved here
 * against suite-owned fixtures — no real corpus id or shared org slug is touched.
 *
 * Isolation tag: `M3LEGACY` / `m3legacy:`.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sourceSystemOf } from "../../scripts/seed.js";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { bearer, mintPrivyToken, seedAccount, testPrivyConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const IMPORT_ID = "m3legacy:import-1";
const IMPORT_NS = "m3legacy-import-ns"; // the stored publisher — never an operating org
const IMPORT_OP = "m3legacy-import-op"; // the only operating org

const API_ID = "m3legacy:api-1";
const API_NS = "m3legacy-api-ns";
const API_OP = "m3legacy-api-op";

const DID = "did:privy:m3legacy-reviewer";

/**
 * A legacy-shaped, NON-conforming document: published under `ns`, operated by `operator` (so the
 * publisher is not one of its operating orgs), with an explicit `ingestedVia`. The id prefix is not
 * the publisher — exactly like the corpus rows, whose ids are `fundingmap:*` while their publisher
 * is the ecosystem namespace.
 */
function legacyDoc(
  id: string,
  ns: string,
  operator: string,
  ingestedVia: "import" | "publisher_api",
): Opportunity {
  return submission(id, ns, {
    operatingOrganizations: [{ name: operator, slug: operator }],
    source: { publisher: ns, ingestedVia },
  }) as unknown as Opportunity;
}

const run = describeWithDb;

run("M3LEGACY replace-time containment and the import-provenance exemption", () => {
  let app: FastifyInstance;
  let reviewerToken: string;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    await seedAccount({ did: DID, handle: "m3legacy-reviewer", role: "reviewer" });
    reviewerToken = await mintPrivyToken(DID);

    // Seeded through the service, NOT the write path — the create-time gate would reject both, which
    // is the whole point: these are rows that reached the DB without passing it.
    const svc = new OpportunityService(db);
    for (const [id, ns, op, via] of [
      [IMPORT_ID, IMPORT_NS, IMPORT_OP, "import"],
      [API_ID, API_NS, API_OP, "publisher_api"],
    ] as const) {
      await svc.upsertFromStandard(legacyDoc(id, ns, op, via), {
        reviewStatus: "approved",
        isListed: true,
        sourceSystem: sourceSystemOf(id) ?? undefined,
      });
    }
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3legacy:",
      organizationSlugs: [IMPORT_OP, API_OP],
      privyDids: [DID],
    });
    await app.close();
    await pool.end();
  });

  it("grandfathers an import-provenance row whose publisher was never an operating org", async () => {
    // A content-only edit (the title). Before the grandfather fix this was a 400; the row entered
    // via `import` and never conformed, so it is exempt and stays editable.
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${IMPORT_ID}`,
      headers: bearer(reviewerToken),
      payload: submission(IMPORT_ID, IMPORT_NS, {
        operatingOrganizations: [{ name: IMPORT_OP, slug: IMPORT_OP }],
        source: { publisher: IMPORT_NS, ingestedVia: "import" },
        title: "Edited legacy import",
      }),
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().opportunity.title).toBe("Edited legacy import");
    // The entry stays under its stored namespace; the edit does not move it.
    expect(edited.json().opportunity.source.publisher).toBe(IMPORT_NS);
  });

  it("does NOT grandfather a publisher_api row: a foreign-operated one is rejected on replace", async () => {
    // Same non-conforming shape, but this row entered through the authenticated write path, so it
    // went through the create-time gate and must stay conforming. The exemption is
    // import-provenance-scoped, not merely "non-conforming".
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${API_ID}`,
      headers: bearer(reviewerToken),
      payload: submission(API_ID, API_NS, {
        operatingOrganizations: [{ name: API_OP, slug: API_OP }],
        source: { publisher: API_NS, ingestedVia: "publisher_api" },
        title: "Attempted edit",
      }),
    });
    expect(edited.statusCode).toBe(400);
    expect(edited.json().error).toBe("publisher_not_operating");
  });
});
