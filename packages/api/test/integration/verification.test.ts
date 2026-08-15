/**
 * Verification-assist: what a fetched page produces, what the fetcher refuses to fetch, and who may
 * ask for a check.
 *
 * Isolation tag: `M3VER` / `m3ver:`.
 *
 * THE TEST THAT COULD NOT EXIST, and how it was resolved. An earlier plan served the "matching page"
 * from `http.createServer` on loopback while requiring the verifier to REFUSE loopback — which is
 * not a hard test to write, it is an impossible one. The resolution is three separate things:
 *
 *   (a) an injected fixture transport, so extraction, the field diff and the redirect walk are
 *       deterministic and need no socket;
 *   (b) the REAL fetcher against real loopback addresses with the guard ON, which is what proves the
 *       refusals — including a redirect whose second hop is loopback;
 *   (c) `VERIFY_ALLOW_PRIVATE_HOSTS` on, for exactly one end-to-end run against a real server, so
 *       the pinned dispatcher, the streaming cap and the content-type check are exercised for real.
 *
 * The escape hatch in (c) is refused outright under `NODE_ENV=production` — `test/unit/config.test.ts`
 * covers that, and it is why the flag can exist at all.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { type AppConfig, config } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import { opportunities, verificationRuns } from "../../src/db/schema.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import type { SourceTransport } from "../../src/modules/services/verification/fetcher.service.js";
import { VerificationService } from "../../src/modules/services/verification/verification.service.js";
import {
  bearer,
  grantMembership,
  mintPrivyToken,
  seedAccount,
  seedOrganization,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { fixtureTransport, sourcePage } from "../helpers/verify-transport.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3ver";
const DIDS = {
  publisher: "did:privy:m3ver-publisher",
  reviewer: "did:privy:m3ver-reviewer",
};

const run = describeWithDb;
const ingest = new OpportunityService();

const MATCH_URL = "https://programmes.example.org/superchain-builders";
const SOFT_404_URL = "https://programmes.example.org/gone";
const OFFSITE_URL = "https://programmes.example.org/moved";
const OFFSITE_DESTINATION = "https://apply.elsewhere-example.net/superchain-builders";

const DEADLINE = "2099-03-01T00:00:00.000Z";

const PAGES = {
  [MATCH_URL]: {
    body: sourcePage({
      title: "Superchain Builders Fund",
      ogTitle: "Superchain Builders Fund | Example Foundation",
      deadline: "March 1, 2099",
      amount: "50,000",
      organization: "Example Foundation",
    }),
  },
  [SOFT_404_URL]: {
    // 200, but the page announces itself as gone — which is how a dead programme normally answers.
    body: "<!doctype html><html><head><title>Page not found</title></head><body>Gone.</body></html>",
  },
  [OFFSITE_URL]: { status: 302, headers: { location: OFFSITE_DESTINATION } },
  [OFFSITE_DESTINATION]: {
    body: sourcePage({ title: "Superchain Builders Fund", organization: "Example Foundation" }),
  },
};

/** A config with the verification knobs this suite needs, everything else as configured. */
function verifyConfig(over: Partial<AppConfig["verification"]>): AppConfig {
  return { ...config, verification: { ...config.verification, ...over } };
}

function serviceWith(
  transport: SourceTransport | undefined,
  over: Partial<AppConfig["verification"]> = {},
) {
  return new VerificationService(db, { transport, config: verifyConfig(over) });
}

async function seedEntry(localId: string, applicationUrl: string | null): Promise<number> {
  await ingest.upsertFromStandard(
    {
      specVersion: "1.0.0",
      id: `${NS}:${localId}`,
      fundingType: "grant",
      title: "Superchain Builders Fund",
      description: "A verification fixture.",
      status: "open",
      operatingOrganizations: [{ name: "Example Foundation", slug: NS }],
      source: { publisher: NS, ingestedVia: "import", verifiedAgainstSource: null },
      ecosystems: ["M3VER"],
      deadlines: [{ deadlineType: "fixed", date: DEADLINE, label: "application" }],
      fundingInfo: { currency: "USD", maxAward: 50000 },
      ...(applicationUrl ? { applicationUrl } : {}),
      fundingDetails: { fundingType: "grant" },
      // biome-ignore lint/suspicious/noExplicitAny: a hand-built Standard fixture, not a mapper output
    } as any,
    { reviewStatus: "approved", isListed: true, sourceSystem: NS },
  );
  const rows = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.publicId, `${NS}:${localId}`))
    .limit(1);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`could not seed ${NS}:${localId}`);
  return id;
}

async function latestRun(opportunityId: number) {
  const rows = await db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.opportunityId, opportunityId))
    .orderBy(desc(verificationRuns.runAt), desc(verificationRuns.id))
    .limit(1);
  return rows[0];
}

run("M3VER verification", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let reviewerToken: string;
  let loopbackPort: number;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const publisher = await seedAccount({ did: DIDS.publisher, handle: "m3ver-publisher" });
    await seedAccount({ did: DIDS.reviewer, handle: "m3ver-reviewer", role: "reviewer" });
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.id, org.id, "owner");
    publisherToken = await mintPrivyToken(DIDS.publisher);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);

    server = createServer((_req, res) => {
      const page = sourcePage({
        title: "Superchain Builders Fund",
        organization: "Example Foundation",
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    loopbackPort = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      privyDids: Object.values(DIDS),
    });
    await app.close();
    await pool.end();
  });

  // ── the fixture-transport half: what a page produces ───────────────────────────
  it("records a matching page as a run, a diff, a snapshot and a flag on the entry", async () => {
    const id = await seedEntry("match", MATCH_URL);
    const view = await serviceWith(fixtureTransport(PAGES)).verify(id);

    expect(view.httpStatus).toBe(200);
    expect(view.existsAtSource).toBe(true);
    expect(view.matched).toBe(true);
    expect(view.error).toBeNull();
    expect(view.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    const diff = view.fieldDiff as Record<string, unknown>;
    expect((diff.title as { matched: boolean }).matched).toBe(true);
    // The deadline is looked for in several written forms, because a site publishes whichever one
    // its designer preferred; the page above writes "March 1, 2099".
    expect((diff.deadlines as { found: boolean }[])[0]?.found).toBe(true);
    // …and the award figure with a thousands separator.
    expect((diff.amounts as { found: boolean }[]).some((a) => a.found)).toBe(true);

    const stored = await latestRun(id);
    expect(stored?.snapshotText, "the extracted text IS the snapshot of record").toContain(
      "Superchain Builders Fund",
    );

    const row = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
    expect(row?.verifiedAgainstSource).toBe(true);
    expect(row?.verifiedAt).toBeTruthy();
    // A SUCCESSFUL check is a "still real" signal, so it resets the staleness clock.
    expect(row?.lastSeenAt).toBeTruthy();
  });

  it("treats a 200 that says it is gone as not existing at source", async () => {
    const id = await seedEntry("soft404", SOFT_404_URL);
    const view = await serviceWith(fixtureTransport(PAGES)).verify(id);

    expect(view.httpStatus).toBe(200);
    expect(view.existsAtSource).toBe(false);
    expect(view.matched).toBe(false);
    const extracted = view.extracted as Record<string, unknown>;
    expect(extracted.softNotFound).toBe(true);
    // WHICH heuristic fired is recorded: one whose reasoning is invisible is one a reviewer has to
    // take on faith.
    expect(String(extracted.softNotFoundHeuristic)).toMatch(/not-found phrase|characters/);

    const row = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
    expect(row?.verifiedAgainstSource).toBe(false);
  });

  it("flags a redirect that leaves the requested site, without refusing it", async () => {
    const id = await seedEntry("offsite", OFFSITE_URL);
    const view = await serviceWith(fixtureTransport(PAGES)).verify(id);

    expect(view.finalUrl).toBe(OFFSITE_DESTINATION);
    const diff = view.fieldDiff as { offDomainRedirect?: { from: string; to: string } };
    // A flag, never a rejection: a foundation legitimately redirects to its grants platform, and a
    // dead programme legitimately redirects to a homepage. Only a reviewer can tell those apart.
    expect(diff.offDomainRedirect).toEqual({
      from: "example.org",
      to: "elsewhere-example.net",
    });
  });

  it("records but does not apply a verdict whose entry changed during the fetch", async () => {
    const id = await seedEntry("raced", MATCH_URL);

    // The publisher's PUT lands while the outbound fetch is in flight. The verdict below was
    // computed from the OLD content, so applying it would stamp `verified_at` later than the
    // edit's `updated_at` — and the backfill predicate is `verified_at < updated_at`, so the new
    // content would be marked current and never re-checked.
    const racing: SourceTransport = async (url, options) => {
      await db
        .update(opportunities)
        .set({ title: "Renamed mid-flight", updatedAt: new Date(Date.now() + 1_000) })
        .where(eq(opportunities.id, id));
      return fixtureTransport(PAGES)(url, options);
    };

    const view = await serviceWith(racing).verify(id);
    // The run is still recorded — a fetch happened and what it found is evidence — and flagged.
    expect(view.error).toMatch(/stale_result/);
    expect(await latestRun(id)).toBeTruthy();

    const row = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
    expect(row?.verifiedAt, "a discarded verdict must not stamp the entry").toBeNull();
    expect(row?.verifiedAgainstSource).toBeNull();

    // …so the entry is still owed a check, which is the whole point of not stamping it.
    expect(await serviceWith(fixtureTransport(PAGES)).pendingIds(10_000)).toContain(id);

    // And the same check against an entry nobody touched applies normally.
    const settled = await serviceWith(fixtureTransport(PAGES)).verify(id);
    expect(settled.error).toBeNull();
    const after = (
      await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1)
    )[0];
    expect(after?.verifiedAt).toBeTruthy();
  });

  it("records a failed run rather than staying silent", async () => {
    const id = await seedEntry("missing", "https://programmes.example.org/nowhere");
    const view = await serviceWith(fixtureTransport(PAGES)).verify(id);
    expect(view.httpStatus).toBe(404);
    expect(view.existsAtSource).toBe(false);
    expect(view.matched).toBe(false);
    expect(await latestRun(id)).toBeTruthy();
  });

  it("refuses an entry with nothing to check against", async () => {
    const id = await seedEntry("nourl", null);
    await expect(serviceWith(fixtureTransport(PAGES)).verify(id)).rejects.toMatchObject({
      code: "no_application_url",
    });
  });

  // ── the real fetcher: what it will not connect to ──────────────────────────────
  it("refuses loopback, the metadata endpoint, and a redirect whose next hop is loopback", async () => {
    const service = serviceWith(undefined, { allowPrivateHosts: false });

    const loopback = await seedEntry("ssrf-loopback", `http://127.0.0.1:${loopbackPort}/`);
    const loopbackRun = await service.verify(loopback);
    expect(loopbackRun.error, "loopback must be refused").toMatch(/address_refused/);
    expect(loopbackRun.matched).toBe(false);

    const metadata = await seedEntry("ssrf-metadata", "http://169.254.169.254/latest/meta-data/");
    const metadataRun = await service.verify(metadata);
    // The one that matters most: this endpoint answers unauthenticated requests with credentials.
    expect(metadataRun.error).toMatch(/address_refused:link-local/);

    const ipv6Mapped = await seedEntry("ssrf-mapped", "http://[::ffff:169.254.169.254]/");
    const mappedRun = await service.verify(ipv6Mapped);
    expect(mappedRun.error, "an IPv4-mapped literal is the same destination").toMatch(
      /address_refused/,
    );

    // A public first hop that redirects to loopback. The first hop is served by a fixture because a
    // test cannot make a real public DNS name redirect anywhere — what is being proved is that hop
    // TWO goes through the same resolve-validate-pin path as hop one, so it is the real transport
    // that answers it.
    const { undiciTransport } = await import(
      "../../src/modules/services/verification/fetcher.service.js"
    );
    const hopOne = "https://redirector.example.org/out";
    const hybrid: SourceTransport = async (url, options) => {
      if (url === hopOne) {
        return {
          status: 302,
          headers: { location: `http://127.0.0.1:${loopbackPort}/` },
          bytes: Buffer.alloc(0),
          truncated: false,
        };
      }
      return undiciTransport(url, options);
    };
    const redirected = await seedEntry("ssrf-redirect", hopOne);
    const redirectedRun = await serviceWith(hybrid, { allowPrivateHosts: false }).verify(
      redirected,
    );
    expect(redirectedRun.error, "the second hop must be validated too").toMatch(/address_refused/);

    const scheme = await seedEntry("ssrf-scheme", "file:///etc/passwd");
    const schemeRun = await service.verify(scheme);
    expect(schemeRun.error).toMatch(/scheme_not_allowed/);
  });

  // ── the real fetcher, end to end, behind the escape hatch ──────────────────────
  it("fetches a real loopback server when the escape hatch is on", async () => {
    const id = await seedEntry("e2e", `http://127.0.0.1:${loopbackPort}/`);
    const view = await serviceWith(undefined, { allowPrivateHosts: true }).verify(id);

    expect(view.error, "the guard is off, so this must actually connect").toBeNull();
    expect(view.httpStatus).toBe(200);
    expect(view.existsAtSource).toBe(true);
    expect(view.matched).toBe(true);
    expect(view.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── the bounded submit-time queue ──────────────────────────────────────────────
  it("skips the submit-time trigger when the queue is full, leaving the entry to the cron", async () => {
    // A transport that never answers until released, so the queue actually fills instead of
    // draining as fast as it is written to.
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking: SourceTransport = async () => {
      await blocked;
      return { status: 200, headers: {}, bytes: Buffer.alloc(0), truncated: false };
    };

    const ids = await Promise.all(
      ["q1", "q2", "q3", "q4"].map((local) =>
        seedEntry(local, "https://programmes.example.org/queued"),
      ),
    );
    // Concurrency is 2 and the queue holds 1, so the fourth enqueue finds it full.
    const service = serviceWith(blocking, { queueMax: 1 });
    for (const id of ids) service.enqueue(id);
    expect(service.queueDepth, "two in flight plus one waiting").toBe(3);

    // The dropped entry is not lost — it still satisfies the cron predicate, which IS the queue.
    const pending = await service.pendingIds(500);
    expect(pending).toContain(ids[3]);

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // ── who may ask ────────────────────────────────────────────────────────────────
  it("lets a reviewer trigger a check and refuses a submitter", async () => {
    await seedEntry("manual", MATCH_URL);

    const refused = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${NS}:manual/verify`,
      headers: bearer(publisherToken),
    });
    expect(refused.statusCode, refused.body).toBe(403);

    // The reviewer route reaches the REAL fetcher, so this hits a host that does not exist and is
    // recorded as a failed run — which is the point: a failure is an answer, not silence.
    const allowed = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${NS}:manual/verify`,
      headers: bearer(reviewerToken),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().requestedUrl).toBe(MATCH_URL);
    expect(allowed.json().matched).toBe(false);
  });

  it("404s a manual verify for an entry that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/review/opportunities/${NS}:nope/verify`,
      headers: bearer(reviewerToken),
    });
    expect(res.statusCode).toBe(404);
  });
});
