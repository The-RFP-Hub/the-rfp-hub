/**
 * Auto-approval, which is a function of the NAMESPACE and the CREDENTIAL together — never of either
 * alone.
 *
 * The last case is the one worth the suite: an account with `direct_create` publishes into any
 * namespace it likes from a session, and the SAME account using a `write`-only API key lands its
 * submission `pending`. That is the escalation hole closed — a leaked key does not inherit the
 * powers of the human it belongs to.
 *
 * Isolation tag: `M3NS` / `m3ns:`.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  mintPrivyToken,
  seedAccount,
  seedOrganization,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const MINE = "m3ns-mine";
const THEIRS = "m3ns-theirs";
const UNVERIFIED = "m3ns-unverified";
const DIDS = {
  publisher: "did:privy:m3ns-publisher",
  direct: "did:privy:m3ns-direct",
};

const run = describeWithDb;

run("M3NS namespace and auto-approval", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let directToken: string;
  let directWriteKey: string;
  let directPublishKey: string;
  let publisherWriteKey: string;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const publisher = await seedAccount({ did: DIDS.publisher, handle: "m3ns-publisher" });
    const direct = await seedAccount({
      did: DIDS.direct,
      handle: "m3ns-direct",
      directCreate: true,
    });

    const mine = await seedOrganization({ slug: MINE, verified: true });
    await seedOrganization({ slug: THEIRS, verified: true });
    const unverified = await seedOrganization({ slug: UNVERIFIED, verified: false });
    await grantMembership(publisher.id, mine.id);
    await grantMembership(publisher.id, unverified.id);

    publisherToken = await mintPrivyToken(DIDS.publisher);
    directToken = await mintPrivyToken(DIDS.direct);
    directWriteKey = await mintApiKeyFor(direct.id, ["read", "write"]);
    directPublishKey = await mintApiKeyFor(direct.id, ["read", "write", "publish"]);
    publisherWriteKey = await mintApiKeyFor(publisher.id, ["read", "write"]);
  });

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: "m3ns-",
      organizationSlugs: [MINE, THEIRS, UNVERIFIED],
      privyDids: Object.values(DIDS),
    });
    await app.close();
    await pool.end();
  });

  const post = async (token: string, id: string, namespace: string) =>
    app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: submission(id, namespace),
    });

  it("publishes a write into a namespace the account holds a VERIFIED membership on", async () => {
    const res = await post(publisherToken, `${MINE}:one`, MINE);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("approved");
  });

  it("queues a write into a namespace the account merely belongs to, unverified", async () => {
    const res = await post(publisherToken, `${UNVERIFIED}:one`, UNVERIFIED);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("pending");
  });

  it("queues a write into somebody else's namespace", async () => {
    const res = await post(publisherToken, `${THEIRS}:one`, THEIRS);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("pending");
  });

  it("lets a direct-create account publish anywhere — from a session", async () => {
    const res = await post(directToken, `${THEIRS}:direct`, THEIRS);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("approved");
  });

  it("lands the SAME direct-create account pending when it uses a write-only key", async () => {
    const res = await post(directWriteKey, `${THEIRS}:direct-key`, THEIRS);
    expect(res.statusCode).toBe(201);
    // Fail CLOSED, not with an error: a submitter who cannot publish still wants the submission
    // recorded, and pending is the safe outcome.
    expect(res.json().reviewStatus).toBe("pending");
    expect(res.json().opportunity.source.ingestedVia).toBe("publisher_api");
  });

  it("publishes for that account again once the key carries `publish`", async () => {
    const res = await post(directPublishKey, `${THEIRS}:direct-publish`, THEIRS);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("approved");
  });

  it("lands a verified publisher's own namespace pending on a write-only key", async () => {
    const res = await post(publisherWriteKey, `${MINE}:key-write`, MINE);
    expect(res.statusCode).toBe(201);
    expect(res.json().reviewStatus).toBe("pending");
  });

  it("refuses a key that carries neither `write` nor `publish`", async () => {
    const readOnly = await mintApiKeyFor((await seedAccount({ did: DIDS.direct })).id, ["read"]);
    const res = await post(readOnly, `${THEIRS}:read-only`, THEIRS);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("missing_scope");
  });

  it("400s a document that names no namespace at all", async () => {
    const { operatingOrganizations: _omitted, ...payload } = submission("nowhere:one", THEIRS);
    const res = await app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(publisherToken),
      payload,
    });
    // The Standard requires `operatingOrganizations`, so this is caught as a validation failure
    // before the namespace rule is reached — which is the right order.
    expect(res.statusCode).toBe(400);
  });
});
