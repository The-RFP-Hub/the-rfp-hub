/**
 * Editing a LEGACY import row whose stored publisher was never one of its operating organisations.
 *
 * The seed corpus carries 14 such records: `source.publisher` is the namespace the entry is filed
 * under, not an organisation that runs the programme — `fundingmap:1042` is published under
 * `optimism` but operated by `optimism-foundation`. The operating-org containment gate must
 * GRANDFATHER these on replace. They did not conform when they were imported, so enforcing
 * containment on an edit would lock them out of ordinary content corrections (a reviewer fixing a
 * title would get a 400). The anti-strip protection stays on for entries that DO conform — proven
 * in namespace-approval.test.ts, alongside the create-time gate that closes the foreign-operated
 * exploit.
 *
 * Isolation tag: the real corpus ids under `fundingmap:`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { documentsFromCorpus, sourceSystemOf } from "../../scripts/seed.js";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { bearer, mintPrivyToken, seedAccount, testPrivyConfig } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const LEGACY_ID = "fundingmap:1042"; // published under `optimism`, operated by `optimism-foundation`
const DID = "did:privy:m3legacy-reviewer";
const CORPUS_PATH = fileURLToPath(new URL("../../data/seed-corpus.json", import.meta.url));

const run = describeWithDb;

run("legacy publisher edit (grandfathered containment)", () => {
  let app: FastifyInstance;
  let reviewerToken: string;
  let legacyDoc: Opportunity;
  let orgSlugs: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    await seedAccount({ did: DID, handle: "m3legacy-reviewer", role: "reviewer" });
    reviewerToken = await mintPrivyToken(DID);

    // The genuine corpus record, inserted exactly as `scripts/seed.ts` inserts it: approved and
    // listed, with its stored `source.publisher` (`optimism`) NOT among its operating orgs.
    const documents = documentsFromCorpus(
      JSON.parse(readFileSync(CORPUS_PATH, "utf8")),
      CORPUS_PATH,
    );
    const doc = documents.find((o) => o.id === LEGACY_ID);
    if (!doc) throw new Error(`${LEGACY_ID} is missing from the seed corpus`);
    legacyDoc = doc;
    orgSlugs = [
      ...doc.operatingOrganizations.map((o) => o.slug),
      ...(doc.sponsoringOrganizations ?? []).map((o) => o.slug),
    ];

    await new OpportunityService(db).upsertFromStandard(doc, {
      reviewStatus: "approved",
      isListed: true,
      sourceSystem: sourceSystemOf(doc.id) ?? undefined,
    });
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "fundingmap:",
      organizationSlugs: orgSlugs,
      privyDids: [DID],
    });
    await app.close();
    await pool.end();
  });

  it("edits a legacy row whose stored publisher was never an operating org", async () => {
    // The stored shape is exactly the non-conforming one the gate must grandfather.
    expect(legacyDoc.source?.publisher).toBe("optimism");
    expect(legacyDoc.operatingOrganizations.map((o) => o.slug)).not.toContain("optimism");

    // A content-only edit (the title) by an authorized writer. Before the grandfather fix this was
    // a 400 `publisher_not_operating`, because `optimism` is not in `operatingOrganizations` — which
    // would have made all 14 legacy records uneditable.
    const edited = await app.inject({
      method: "PUT",
      url: `/v1/opportunities/${LEGACY_ID}`,
      headers: bearer(reviewerToken),
      payload: { ...legacyDoc, title: "Optimism Season 9 — Audit Grants (edited)" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().opportunity.title).toBe("Optimism Season 9 — Audit Grants (edited)");
    // The entry stays under its stored namespace; the edit does not move it.
    expect(edited.json().opportunity.source.publisher).toBe("optimism");
  });
});
