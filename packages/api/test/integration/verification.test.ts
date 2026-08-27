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
import { runJob } from "../../src/modules/services/jobs/runner.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import {
  SourceFetchError,
  type SourceTransport,
} from "../../src/modules/services/verification/fetcher.service.js";
import { VerificationService } from "../../src/modules/services/verification/verification.service.js";
import {
  bearer,
  grantMembership,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { fixtureTransport, sourcePage } from "../helpers/verify-transport.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3ver";
const EMAILS = {
  publisher: "m3ver-publisher@rfphub.invalid",
  reviewer: "m3ver-reviewer@rfphub.invalid",
};

const run = describeWithDb;
const ingest = new OpportunityService();

const MATCH_URL = "https://programmes.example.org/superchain-builders";
const SOFT_404_URL = "https://programmes.example.org/gone";
const OFFSITE_URL = "https://programmes.example.org/moved";
const OFFSITE_DESTINATION = "https://apply.elsewhere-example.net/superchain-builders";
const CHALLENGE_URL = "https://programmes.example.org/challenge";

const DEADLINE = "2099-03-01T00:00:00.000Z";
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

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
  [CHALLENGE_URL]: {
    body: "<!doctype html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>",
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

type Deadline = { deadlineType: "fixed" | "rolling"; date?: string; label?: string };

const FIXED_DEADLINE: Deadline[] = [
  { deadlineType: "fixed", date: DEADLINE, label: "application" },
];

async function seedEntry(
  localId: string,
  applicationUrl: string | null,
  deadlines: Deadline[] = FIXED_DEADLINE,
): Promise<number> {
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
      deadlines,
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

async function load(opportunityId: number) {
  const rows = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no opportunity ${opportunityId}`);
  return row;
}

/** Every run for an entry, newest first — the order the read path and the prune both use. */
async function runsFor(opportunityId: number) {
  return db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.opportunityId, opportunityId))
    .orderBy(desc(verificationRuns.runAt), desc(verificationRuns.id));
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

/**
 * The real staleness job, through the runner so it takes the same advisory lock every other caller
 * does. Another suite running it concurrently reports `skipped: "locked"` rather than walking the
 * table twice, so this retries a few times rather than asserting against a pass that never ran.
 */
async function runStaleness(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const report = await runJob("staleness", { maxPasses: 1 });
    if (report.skipped !== "locked") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the staleness lock was held for every attempt");
}

run("M3VER verification", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let reviewerToken: string;
  let loopbackPort: number;
  let server: ReturnType<typeof createServer>;

  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3ver-publisher" });
    const reviewer = await seedIdentity(EMAILS.reviewer, {
      handle: "m3ver-reviewer",
      role: "reviewer",
    });
    userIds.push(publisher.userId, reviewer.userId);
    const org = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, org.id, "owner");
    publisherToken = publisher.token;
    reviewerToken = reviewer.token;

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
      userIds,
      emails: Object.values(EMAILS),
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

  it("records a challenge-shaped response without changing its not-verified semantics", async () => {
    const id = await seedEntry("challenge", CHALLENGE_URL);
    const view = await serviceWith(fixtureTransport(PAGES)).verify(id);

    expect(view.httpStatus).toBe(200);
    expect(view.existsAtSource).toBe(false);
    expect(view.matched).toBe(false);
    expect(view.extracted).toMatchObject({
      automatedCheckBlocked: true,
      automatedCheckBlockedHeuristic: expect.stringContaining("automated-access challenge"),
    });

    const row = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
    expect(row?.verifiedAgainstSource).toBe(false);
  });

  it("does not let a failed run revert a newer `lastSeenAt` a concurrent successful run committed", async () => {
    // This run's own successful-write path does not touch `updatedAt` (see the source comment at
    // verification.service.ts), so a second, overlapping run's compare-and-set against
    // `updated_at` cannot see that `lastSeenAt` moved. The transport below fires exactly where a
    // concurrent successful run's commit would land — after this run's OWN pre-fetch snapshot is
    // taken, before its locked re-read — and this run resolves as a non-match (a soft-404 page),
    // so it must write back the LOCKED row's `lastSeenAt`, not its own stale snapshot.
    const id = await seedEntry("no-clock-regression", SOFT_404_URL);
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(opportunities).set({ lastSeenAt: stale }).where(eq(opportunities.id, id));

    const concurrentlyCommitted = new Date(Date.now() - 30 * 1000);
    const transport: SourceTransport = async () => {
      // The "concurrent successful run", modelled as a direct write landing mid-fetch: newer
      // `lastSeenAt`, `updatedAt` untouched — exactly what the real success path does.
      await db
        .update(opportunities)
        .set({ lastSeenAt: concurrentlyCommitted })
        .where(eq(opportunities.id, id));
      return {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        bytes: Buffer.from(PAGES[SOFT_404_URL].body ?? ""),
        truncated: false,
      };
    };

    const view = await serviceWith(transport).verify(id);
    expect(
      view.matched,
      "the soft-404 page must not match, or this is testing the wrong branch",
    ).toBe(false);

    const row = (await db.select().from(opportunities).where(eq(opportunities.id, id)).limit(1))[0];
    // Proves the non-stale write branch actually ran (the entry's own content and URL never
    // changed, so the compare-and-set correctly saw it as current).
    expect(row?.verifiedAt).toBeTruthy();
    expect(row?.lastSeenAt?.getTime()).toBe(concurrentlyCommitted.getTime());
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

  /**
   * The rebinding shape: a NAME, not a literal, whose resolution is what decides the destination —
   * and which is resolved at the hop it is used on rather than inherited from an earlier one.
   *
   * This is the case the literal-address tests above cannot reach. `127.0.0.1` in a URL is refused
   * by looking at the URL; `localhost` is only refused by resolving it, which is the step an
   * attacker controls the answer to. Doing that resolution ONCE, up front, and then letting the
   * connection re-resolve is the classic time-of-check/time-of-use hole this fetcher is built to
   * close — so both hops are checked here, with the same hostname on each, and the second one is
   * answered by the REAL transport.
   *
   * No DNS is mocked. This repository validates through injected seams rather than module mocks,
   * and `localhost` gives a genuinely-resolved name that lands on a private address, which is
   * exactly what is needed.
   */
  it("resolves a hostname at every hop, so a name that lands on a private address is refused", async () => {
    const service = serviceWith(undefined, { allowPrivateHosts: false });

    // Hop one: the name is resolved and refused before any connection is attempted.
    const direct = await seedEntry("ssrf-name-hop1", `http://localhost:${loopbackPort}/`);
    const directRun = await service.verify(direct);
    expect(directRun.error, "a hostname that resolves to loopback is refused").toMatch(
      /address_refused/,
    );
    expect(directRun.httpStatus, "no request may have been made").toBeNull();

    // Hop two: a public first hop redirects to that same name. The first hop is injected because a
    // test cannot make a real public name redirect anywhere; hop two goes through the real
    // transport, which must resolve and classify the name AGAIN rather than trusting hop one.
    const { undiciTransport } = await import(
      "../../src/modules/services/verification/fetcher.service.js"
    );
    const hopOne = "https://rebinding.example.org/out";
    const hybrid: SourceTransport = async (url, options) => {
      if (url === hopOne) {
        return {
          status: 302,
          headers: { location: `http://localhost:${loopbackPort}/` },
          bytes: Buffer.alloc(0),
          truncated: false,
        };
      }
      return undiciTransport(url, options);
    };

    const rebound = await seedEntry("ssrf-name-hop2", hopOne);
    const reboundRun = await serviceWith(hybrid, { allowPrivateHosts: false }).verify(rebound);
    expect(reboundRun.error, "hop two's hostname must be resolved and classified too").toMatch(
      /address_refused/,
    );
    expect(reboundRun.existsAtSource).toBe(false);
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

  // ── the re-check TTL: a check expires ──────────────────────────────────────────
  /**
   * THE BUG THIS CLOSES. `applyVerification` deliberately does not touch `updated_at`, so once
   * `verified_at` is stamped the old predicate's `verified_at < updated_at` is false and stays
   * false: a seeded entry nobody ever edits was checked exactly once, on the day it was imported,
   * and never again. The TTL clause is the only thing that brings it back.
   */
  it("re-selects an entry whose check has gone stale, and would not have without the TTL", async () => {
    const id = await seedEntry("ttl", MATCH_URL);
    const service = serviceWith(fixtureTransport(PAGES), { recheckDays: 30 });

    await service.verify(id);
    expect(await service.pendingIds(10_000), "just checked, so nothing is owed").not.toContain(id);

    // The shape a seeded corpus entry is actually in forty days on: imported, checked once shortly
    // after, and never edited since — so `verified_at > updated_at` and nothing else has moved.
    await db
      .update(opportunities)
      .set({ updatedAt: ago(41), verifiedAt: ago(40) })
      .where(eq(opportunities.id, id));

    expect(await service.pendingIds(10_000)).toContain(id);
    // …and the old rules alone would have left it retired for good.
    const noTtl = serviceWith(fixtureTransport(PAGES), { recheckDays: 36_500 });
    expect(
      await noTtl.pendingIds(10_000),
      "the pre-TTL predicate never re-selects it",
    ).not.toContain(id);
  });

  it("puts the never-checked ahead of the merely stale, and takes the cap off the head", async () => {
    const never = await seedEntry("order-never", MATCH_URL);
    const stale = await seedEntry("order-stale", MATCH_URL);
    const service = serviceWith(fixtureTransport(PAGES), { recheckDays: 30 });
    await service.verify(stale);
    await db
      .update(opportunities)
      .set({ updatedAt: ago(41), verifiedAt: ago(40) })
      .where(eq(opportunities.id, stale));

    const all = await service.pendingIds(10_000);
    expect(all).toContain(never);
    expect(all).toContain(stale);
    // `verified_at ASC NULLS FIRST`: an entry nobody has ever fetched is worth more than one whose
    // check is a month old, and when the cap bites it is the re-check that is dropped.
    expect(all.indexOf(never)).toBeLessThan(all.indexOf(stale));

    // The cap is a prefix of that order, not an arbitrary subset — a capped run must be
    // deterministic, or two nights running would work through the corpus at random.
    const capped = await service.pendingIds(3);
    expect(capped.length).toBeLessThanOrEqual(3);
    expect(capped).toEqual(all.slice(0, capped.length));
  });

  // ── a failed fetch is not a verdict ────────────────────────────────────────────
  it("records a transport failure as a run without retiring the entry or its last verdict", async () => {
    const timingOut: SourceTransport = async () => {
      throw new SourceFetchError("connect ETIMEDOUT", "timeout", MATCH_URL);
    };

    // A never-checked entry stays never-checked: the run is recorded, the entry stays owed a check.
    const fresh = await seedEntry("transient-fresh", MATCH_URL);
    const view = await serviceWith(timingOut).verify(fresh);
    expect(view.error).toMatch(/not_a_verdict/);
    expect(view.error).toMatch(/timeout/);
    expect(await latestRun(fresh), "we tried, and that is still evidence").toBeTruthy();

    const freshRow = await load(fresh);
    expect(freshRow.verifiedAt, "an outage must not count as a check").toBeNull();
    expect(freshRow.verifiedAgainstSource).toBeNull();
    expect(await serviceWith(fixtureTransport(PAGES)).pendingIds(10_000)).toContain(fresh);

    // And an entry that HAS a verdict keeps it: a timeout is not evidence the page stopped matching.
    const known = await seedEntry("transient-known", MATCH_URL);
    await serviceWith(fixtureTransport(PAGES)).verify(known);
    const before = await load(known);
    expect(before.verifiedAgainstSource).toBe(true);

    await serviceWith(timingOut).verify(known);
    const after = await load(known);
    expect(after.verifiedAt?.getTime()).toBe(before.verifiedAt?.getTime());
    expect(after.verifiedAgainstSource).toBe(true);
    expect(after.lastSeenAt?.getTime()).toBe(before.lastSeenAt?.getTime());
  });

  /**
   * A server answering `302` with a `Location` of `http://` is broken in a way that will still be
   * broken tomorrow. Before it had a category of its own it surfaced as `transport_failure` — the
   * bucket verification treats as transient — so the entry was never stamped and was re-fetched
   * every single night, forever, on the strength of a header that is never going to change.
   */
  it("treats a redirect to a malformed Location as a verdict, not as a network failure", async () => {
    const BROKEN = "https://programmes.example.org/broken-redirect";
    const id = await seedEntry("redirect-malformed", BROKEN);
    const view = await serviceWith(
      fixtureTransport({ ...PAGES, [BROKEN]: { status: 302, headers: { location: "http://" } } }),
      { recheckDays: 30 },
    ).verify(id);

    expect(view.error).toMatch(/redirect_malformed/);
    expect(view.error, "not the transient bucket").not.toMatch(/not_a_verdict/);

    const row = await load(id);
    expect(row.verifiedAt, "stamped, so it waits for the TTL like any other verdict").toBeTruthy();
    expect(row.verifiedAgainstSource).toBe(false);
    expect(
      await serviceWith(fixtureTransport(PAGES), { recheckDays: 30 }).pendingIds(10_000),
    ).not.toContain(id);
  });

  it("still retires an entry whose URL is refused, because that IS an answer about the URL", async () => {
    // The contrast that makes the rule above a rule rather than "failures are ignored":
    // `scheme_not_allowed` is a fact about what the submitter typed, and re-fetching it nightly
    // would learn nothing.
    const id = await seedEntry("refused-stamps", "file:///etc/passwd");
    const view = await serviceWith(undefined, { allowPrivateHosts: false }).verify(id);
    expect(view.error).toMatch(/scheme_not_allowed/);
    expect(view.error).not.toMatch(/not_a_verdict/);

    const row = await load(id);
    expect(
      row.verifiedAt,
      "a refusal is a verdict and retires the entry until the TTL",
    ).toBeTruthy();
    expect(row.verifiedAgainstSource).toBe(false);
  });

  // ── the staleness clock the re-check exists to keep winding ────────────────────
  /**
   * The ninety-day hazard, end to end. A rolling entry has no `next_deadline_at`, so `staleness`
   * closes it once `coalesce(last_seen_at, updated_at)` is 90 days old — and the ONLY thing that
   * refreshes `last_seen_at` is a MATCHED check. One check at import time, then silence, and the
   * whole rolling half of a seeded corpus auto-closes a quarter later.
   *
   * Both halves are asserted, because "it stayed open" means nothing without a neighbour that did
   * not: the re-checked entry survives the same pass that closes the abandoned one.
   */
  it("keeps a rolling entry alive through the staleness pass — and closes its unchecked neighbour", async () => {
    const rolling: Deadline[] = [{ deadlineType: "rolling", label: "rolling" }];
    const kept = await seedEntry("rolling-rechecked", MATCH_URL, rolling);
    const abandoned = await seedEntry("rolling-abandoned", MATCH_URL, rolling);

    // Two hundred days of silence apiece: checked once when they were imported, never since.
    const silent = ago(200);
    for (const id of [kept, abandoned]) {
      await db
        .update(opportunities)
        .set({ verifiedAt: silent, lastSeenAt: silent, updatedAt: silent, nextDeadlineAt: null })
        .where(eq(opportunities.id, id));
    }

    const service = serviceWith(fixtureTransport(PAGES), { recheckDays: 30 });
    expect(await service.pendingIds(10_000), "the TTL is what brings it back").toContain(kept);

    const view = await service.verify(kept);
    expect(view.matched, "a match is what resets the staleness clock").toBe(true);
    expect((await load(kept)).lastSeenAt?.getTime()).toBeGreaterThan(silent.getTime());
    expect(
      (await load(kept)).updatedAt.getTime(),
      "and it does so without bumping `updated_at`, which two other predicates read",
    ).toBe(silent.getTime());

    await runStaleness();

    expect((await load(kept)).status, "re-checked, so still open").toBe("open");
    expect((await load(abandoned)).status, "never re-checked, so closed as inactive").toBe(
      "closed",
    );
  });

  // ── a re-check that finds nothing moved ────────────────────────────────────────
  /**
   * The digest is over the RAW BYTES, so an equal digest is proof the page has not changed since
   * the last check — which is what a monthly re-check finds almost every time.
   *
   * Two things are asserted, and the second is the one that would be easy to get wrong: the run is
   * flagged as carrying nothing new, AND it still refreshes `verified_at` and `last_seen_at`,
   * because "the page is exactly as it was and it still matches" is a stronger "still real" signal
   * than a page that changed, not a weaker one.
   */
  it("marks a re-check of an unmoved page as unchanged, and still winds the clocks on", async () => {
    const id = await seedEntry("unchanged", MATCH_URL);
    const service = serviceWith(fixtureTransport(PAGES), { recheckDays: 30 });

    const first = await service.verify(id);
    const firstRun = await latestRun(id);
    expect((first.extracted as Record<string, unknown>).snapshotUnchanged).toBeUndefined();
    expect(firstRun?.snapshotText).toContain("Superchain Builders Fund");

    // A month passes and nothing at the source moves.
    await db
      .update(opportunities)
      .set({ updatedAt: ago(41), verifiedAt: ago(40), lastSeenAt: ago(40) })
      .where(eq(opportunities.id, id));

    const second = await service.verify(id);
    expect(second.snapshotSha256).toBe(first.snapshotSha256);
    expect((second.extracted as Record<string, unknown>).snapshotUnchanged).toBe(true);
    expect((second.extracted as Record<string, unknown>).snapshotUnchangedSince).toBe(
      firstRun?.runAt.toISOString(),
    );
    expect(second.matched).toBe(true);

    // The text is carried forward rather than dropped: retention deletes older runs, so a run whose
    // snapshot lived only on a pruned ancestor would carry a digest of bytes nobody stores.
    const secondRun = await latestRun(id);
    expect(secondRun?.snapshotText).toBe(firstRun?.snapshotText);

    const row = await load(id);
    expect(row.verifiedAt?.getTime()).toBeGreaterThan(ago(40).getTime());
    expect(row.lastSeenAt?.getTime()).toBeGreaterThan(ago(40).getTime());
    expect(await service.pendingIds(10_000), "and the entry is settled again").not.toContain(id);
  });

  /**
   * THE PREFIX TRAP. `snapshot_sha256` is a digest of the bytes that were RETAINED, and
   * `VERIFY_MAX_BYTES` stops the stream at 2 MiB — so two genuinely different versions of a long
   * page that happen to share their first 2 MiB hash identically. Calling that "unchanged" is a
   * claim about a prefix wearing the clothes of a claim about the page, and it would then refresh
   * `verified_at` and `last_seen_at` on the strength of it.
   *
   * Both directions matter and both are asserted: the CURRENT fetch being truncated is not enough
   * to trust, and neither is the PREVIOUS one, because the comparison needs two complete sides.
   */
  it("never calls a page unchanged when either fetch stopped at the byte cap", async () => {
    const capped = fixtureTransport({
      ...PAGES,
      [MATCH_URL]: { body: PAGES[MATCH_URL]?.body, truncated: true },
    });
    const whole = fixtureTransport(PAGES);

    // Truncated, then truncated again: identical digests over identical prefixes, and no claim.
    const both = await seedEntry("truncated-both", MATCH_URL);
    const first = await serviceWith(capped, { recheckDays: 30 }).verify(both);
    expect((first.extracted as Record<string, unknown>).truncated).toBe(true);
    const second = await serviceWith(capped, { recheckDays: 30 }).verify(both);
    expect(second.snapshotSha256, "the digests DO match — that is the trap").toBe(
      first.snapshotSha256,
    );
    expect(
      (second.extracted as Record<string, unknown>).snapshotUnchanged,
      "equal prefixes are not equal pages",
    ).toBeUndefined();

    // A complete fetch after a truncated one: the stored side is a prefix, so there is still
    // nothing to compare against.
    const after = await seedEntry("truncated-then-whole", MATCH_URL);
    await serviceWith(capped, { recheckDays: 30 }).verify(after);
    const complete = await serviceWith(whole, { recheckDays: 30 }).verify(after);
    expect((complete.extracted as Record<string, unknown>).snapshotUnchanged).toBeUndefined();

    // …and once both sides are complete, the claim is made again. The rule is "both complete", not
    // "this entry was truncated once and is now suspect forever".
    const settled = await serviceWith(whole, { recheckDays: 30 }).verify(after);
    expect((settled.extracted as Record<string, unknown>).snapshotUnchanged).toBe(true);
  });

  it("does not call a page unchanged when its bytes moved", async () => {
    const id = await seedEntry("changed", MATCH_URL);
    const service = serviceWith(fixtureTransport(PAGES), { recheckDays: 30 });
    await service.verify(id);

    const edited = fixtureTransport({
      ...PAGES,
      [MATCH_URL]: {
        body: sourcePage({
          title: "Superchain Builders Fund",
          organization: "Example Foundation",
          amount: "75,000",
        }),
      },
    });
    const second = await serviceWith(edited, { recheckDays: 30 }).verify(id);
    expect((second.extracted as Record<string, unknown>).snapshotUnchanged).toBeUndefined();
    expect((await latestRun(id))?.snapshotText).toContain("75,000");
  });

  // ── retention: the run log is bounded ──────────────────────────────────────────
  /**
   * A run carries up to 200 KB of `snapshot_text`. Left alone, an entry re-checked on a schedule
   * grows an unbounded log of pages nobody reads past the most recent few — so the backfill prunes
   * to the newest N per entry it touched, and the ONE run that must always survive is the latest,
   * because that is what the public verification endpoint serves.
   *
   * Driven through `pruneRuns` rather than `runBatch` on purpose: `runBatch`'s selection is the
   * whole table, and a test that ran it would verify — and stamp — entries belonging to every other
   * suite sharing this database.
   */
  /**
   * THE PATH THAT ACTUALLY APPENDS MOST. A reviewer's manual verify and the submit-time queue both
   * write runs without ever going through the backfill, and an entry that is checked often is
   * precisely the one whose `verified_at` is always fresh — so the batch prune, which only ever
   * sees what the backfill SELECTED, would never have covered it. The bound therefore lives at the
   * point of insertion: N + 3 checks leave N runs, not N + 3.
   */
  it("holds every entry to N runs however the runs were written", async () => {
    const id = await seedEntry("retention", MATCH_URL);
    const keep = 3;
    const service = serviceWith(fixtureTransport(PAGES), { runsKeep: keep });

    for (let i = 0; i < keep + 3; i++) await service.verify(id);

    const runs = await runsFor(id);
    expect(runs.length, "N + 3 checks, N runs").toBe(keep);

    // The property the retention bound must never break: the endpoint still answers with the most
    // recent run, and it is the newest of the survivors.
    const res = await app.inject({
      method: "GET",
      url: `/v1/opportunities/${NS}:retention/verification`,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().runAt).toBe(runs[0]?.runAt.toISOString());
    expect(res.json().matched).toBe(true);
  });

  /**
   * The batch prune is still there, and still does something: it is the backstop for rows written
   * before this bound existed, and for a keep value an operator has just lowered. Driven against
   * rows inserted directly, because the service path can no longer produce an over-long log.
   *
   * Driven through `pruneRuns` rather than `runBatch` on purpose: `runBatch`'s selection is the
   * whole table, and a test that ran it would verify — and stamp — entries belonging to every other
   * suite sharing this database.
   */
  it("prunes a backlog down to the newest N, and leaves ids it was not given alone", async () => {
    const id = await seedEntry("retention-backlog", MATCH_URL);
    const neighbour = await seedEntry("retention-neighbour", MATCH_URL);
    const keep = 3;

    // Eight runs apiece, written straight to the table the way a deployment predating the bound
    // would have accumulated them.
    for (const opportunityId of [id, neighbour]) {
      for (let i = 0; i < 8; i++) {
        await db.insert(verificationRuns).values({
          opportunityId,
          runAt: new Date(Date.now() - (8 - i) * 60_000),
          requestedUrl: MATCH_URL,
          existsAtSource: true,
          matched: true,
          snapshotText: `run ${i}`,
          snapshotSha256: "0".repeat(64),
        });
      }
    }

    const before = await runsFor(id);
    expect(before.length).toBe(8);
    const newest = before.slice(0, keep).map((row) => row.id);

    const service = serviceWith(fixtureTransport(PAGES), { runsKeep: keep });
    expect(await service.pruneRuns([id])).toBe(8 - keep);

    const after = await runsFor(id);
    expect(
      after.map((row) => row.id),
      "the newest N survive, in order",
    ).toEqual(newest);
    expect((await runsFor(neighbour)).length, "an id the prune was not given is untouched").toBe(8);

    // Pruning twice is not an error and removes nothing further.
    expect(await service.pruneRuns([id])).toBe(0);
  });

  // ── the nightly budget, end to end ─────────────────────────────────────────────
  /**
   * `remaining` is what the runner loops on, so a capped pass has to report `0` or a 500 cap
   * becomes twenty of them. The arithmetic is unit-tested in `test/unit/verification-budget.test.ts`;
   * what is proved here is that `runBatch` really is wired to it and really does read
   * `pendingCount` for the deferred figure.
   *
   * A SPENT BUDGET rather than a filled one, deliberately: `limit: 0` exercises the same branch
   * while fetching nothing at all, and an unscoped batch with a real limit would fetch and stamp
   * whichever entry sorts first in a database shared with every other suite.
   */
  /**
   * THE BUDGET IS THE INVOCATION'S. `runner.ts` will call a cursor job up to twenty times while it
   * is making progress, so a limit that resets per pass is not a limit — 500 becomes 10,000, and a
   * pass that comes in UNDER its limit leaks just as surely as one that fills it.
   *
   * The SELECTION is scoped here and nothing else is: `pendingIds` is overridden so this test
   * fetches its own five entries instead of whichever rows sort first in a database shared with
   * every other suite. Everything under test is real — the budget arithmetic, the decrement per
   * attempt, the loop, `verifyOnce`, the run rows — and the selection has its own tests above.
   */
  it("spends one budget across every batch on the service, not one per batch", async () => {
    const ids: number[] = [];
    for (const local of ["budget-1", "budget-2", "budget-3", "budget-4", "budget-5"]) {
      ids.push(await seedEntry(local, MATCH_URL));
    }

    let fetches = 0;
    const counting: SourceTransport = async (url, options) => {
      fetches++;
      return fixtureTransport(PAGES)(url, options);
    };

    class ScopedService extends VerificationService {
      override async pendingIds(limit: number): Promise<number[]> {
        return ids.slice(0, limit);
      }
    }
    const service = new ScopedService(db, {
      transport: counting,
      config: verifyConfig({ recheckDays: 30 }),
    });

    const first = await service.runBatch({ limit: 3 });
    expect(first.processed).toBe(3);
    expect(fetches).toBe(3);
    // All three entries share a host, so the real pacer really did hold the batch between them —
    // which is also the only place the whole wiring (service → `fetchSource` → transport → pacer)
    // is exercised end to end. The spacing's own edge cases are unit-tested against a fake clock.
    //
    // A FLOOR, NOT A FIGURE. The gap is measured from the last reservation, so the time this run
    // spends fetching and committing counts toward it: two gaps against a 1 s spacing come to a
    // little under 2 s, by however long the work in between took. Asserting 2 s exactly is
    // asserting that the database was instant.
    expect(
      first.details?.pacedMs,
      "more than one full gap, so the batch really was held between hosts it shares",
    ).toBeGreaterThan(1_000);

    // The same instance, asked again exactly as the runner's second pass would ask.
    const second = await service.runBatch({ limit: 3 });
    expect(second.processed, "the budget was spent by the first batch").toBe(0);
    expect(second.details?.selected).toBe(0);
    expect(fetches, "three fetches for the invocation, not three per pass").toBe(3);

    // Two of the five were never touched, and the report says so rather than hiding it.
    for (const id of ids.slice(3)) expect((await load(id)).verifiedAt).toBeNull();
    expect(second.remaining, "and it still does not ask to be looped").toBe(0);
  });

  it("reports a spent budget as `remaining: 0`, with what is still owed deferred", async () => {
    await seedEntry("budget", MATCH_URL);
    const service = serviceWith(fixtureTransport(PAGES), { recheckDays: 30 });

    const owed = await service.pendingCount();
    expect(
      owed,
      "the entry just seeded is owed a check, so there is something to defer",
    ).toBeGreaterThan(0);

    const report = await service.runBatch({ limit: 0 });
    expect(report.processed).toBe(0);
    expect(report.remaining, "zero means: do not come round again tonight").toBe(0);
    expect(report.details?.deferred).toBe(owed);
    expect(report.details?.selected).toBe(0);
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
