/**
 * WHERE THE JSON-LD CONTEXT LINK HEADER MAY AND MAY NOT GO.
 *
 * The header instructs a conformant processor to interpret an `application/json` body THROUGH the
 * opportunity context — so putting it on a submission envelope, a claim decision, an audit trail or
 * a key listing would publish those as RFP Hub opportunities. Nothing about the body would look
 * wrong; the damage is entirely in the advertisement.
 *
 * The mechanism is Fastify encapsulation plus an explicit operation allowlist, and this suite is
 * what proves both halves rather than trusting the plugin split.
 *
 * Isolation tag: `M3LD` / `m3ld:`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { JSONLD_CONTEXT_LINK } from "../../src/modules/shared/jsonld-link.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3ld";
const EMAIL = "m3ld-publisher@rfphub.invalid";
const PUBLIC_ID = `${NS}:one`;

const run = describeWithDb;
const ingest = new OpportunityService();

const linkOf = (headers: Record<string, unknown>) => String(headers.link ?? "");

run("M3LD JSON-LD context scope", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    const publisher = await seedIdentity(EMAIL, { handle: "m3ld-publisher" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, org.id, "owner");
    token = publisher.token;
    userId = publisher.userId;

    await ingest.upsertFromStandard(
      {
        specVersion: "1.0.0",
        id: PUBLIC_ID,
        fundingType: "grant",
        title: "Context fixture",
        description: "d",
        status: "open",
        operatingOrganizations: [{ name: NS, slug: NS }],
        source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
        ecosystems: ["M3LD"],
        fundingDetails: { fundingType: "grant" },
      },
      { reviewStatus: "approved", isListed: true, sourceSystem: NS },
    );
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      userIds: [userId],
      emails: [EMAIL],
    });
    await app.close();
    await pool.end();
  });

  it("advertises the context on the list and the detail — the two Standard responses", async () => {
    for (const url of ["/v1/opportunities?ecosystem=M3LD", `/v1/opportunities/${PUBLIC_ID}`]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(linkOf(res.headers), url).toBe(JSONLD_CONTEXT_LINK);
    }
  });

  it("never advertises it on a write, a claim, or an opportunity sub-resource", async () => {
    const responses: [string, Awaited<ReturnType<FastifyInstance["inject"]>>][] = [
      [
        "POST /v1/opportunities",
        await app.inject({
          method: "POST",
          url: "/v1/opportunities",
          headers: bearer(token),
          payload: submission(`${NS}:written`, NS),
        }),
      ],
      [
        "PUT /v1/opportunities/:id",
        await app.inject({
          method: "PUT",
          url: `/v1/opportunities/${NS}:written`,
          headers: bearer(token),
          payload: submission(`${NS}:written`, NS, { title: "Replaced" }),
        }),
      ],
      [
        "POST /v1/opportunities/:id/claim",
        await app.inject({
          method: "POST",
          url: `/v1/opportunities/${PUBLIC_ID}/claim`,
          headers: bearer(token),
          payload: { organizationSlug: NS },
        }),
      ],
      ["GET :id/audit", await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}/audit` })],
      [
        "GET :id/duplicates",
        await app.inject({ url: `/v1/opportunities/${PUBLIC_ID}/duplicates` }),
      ],
    ];

    for (const [name, res] of responses) {
      expect(res.statusCode, `${name} → ${res.body}`).toBeLessThan(400);
      expect(linkOf(res.headers), name).not.toContain("json-ld#context");
    }
  });

  it("never advertises it on the identity, review or publisher surfaces", async () => {
    const responses: [string, Awaited<ReturnType<FastifyInstance["inject"]>>][] = [
      ["GET /v1/me", await app.inject({ url: "/v1/me", headers: bearer(token) })],
      ["GET /v1/keys", await app.inject({ url: "/v1/keys", headers: bearer(token) })],
      [
        "GET /v1/me/opportunities",
        await app.inject({ url: "/v1/me/opportunities", headers: bearer(token) }),
      ],
      ["GET /v1/publishers", await app.inject({ url: "/v1/publishers" })],
    ];
    for (const [name, res] of responses) {
      expect(res.statusCode, name).toBe(200);
      expect(linkOf(res.headers), name).not.toContain("json-ld#context");
    }
  });

  it("never advertises it on an error body, whose keys are not terms in the context", async () => {
    const res = await app.inject({ url: "/v1/opportunities/m3ld:missing" });
    expect(res.statusCode).toBe(404);
    expect(linkOf(res.headers)).not.toContain("json-ld#context");
  });
});
