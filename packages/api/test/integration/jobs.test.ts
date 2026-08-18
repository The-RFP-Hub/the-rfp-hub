/**
 * The scheduled jobs against a real database: both staleness passes, idempotency, the advisory
 * lock, the sweep contract, and the credential matrix on the convenience route.
 *
 * Isolation tag: `M3JOB` / `m3job:`.
 *
 * The six fixtures are the whole of D-17's decision table, including the two rows the rule is
 * easiest to get wrong: a rolling-only entry nobody has touched for four months DOES close, and a
 * rolling-only entry touched yesterday does NOT. Both are asserted, in both directions.
 */
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { db, pool } from "../../src/db/client.js";
import { type OpportunityRow, accounts, auditLog, opportunities } from "../../src/db/schema.js";
import { AccountEnrichmentService } from "../../src/modules/services/jobs/account-enrichment.service.js";
import { advisoryLockKey } from "../../src/modules/services/jobs/lock.js";
import { runJob } from "../../src/modules/services/jobs/runner.js";
import { StalenessService } from "../../src/modules/services/jobs/staleness.service.js";
import {
  bearer,
  mintApiKeyFor,
  mintPrivyToken,
  seedAccount,
  testPrivyConfig,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3job";
const DIDS = {
  admin: "did:privy:m3job-admin",
  reviewer: "did:privy:m3job-reviewer",
  enriched: "did:privy:m3job-enriched",
  enrichFailed: "did:privy:m3job-enrich-failed",
};

/** The address the fixture's identity provider reports for the enriched account. */
const PROVIDER_WALLET = "0xa11ce0000000000000000000000000000000b0b5";

const DAY = 86_400_000;
const NOW = new Date("2026-08-14T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

type Deadline = { deadlineType: "fixed" | "rolling"; date?: string; label?: string };

interface Fixture {
  local: string;
  deadlines: Deadline[];
  /** Stored derived key, deliberately allowed to be wrong so the recompute has something to do. */
  nextDeadlineAt?: Date | null;
  lastSeenAt: Date;
}

const FIXTURES: Fixture[] = [
  // 1 — a fixed deadline that has passed, and nothing rolling: closed as past_due.
  { local: "past-fixed", deadlines: [fixed(ago(10))], lastSeenAt: ago(1) },
  // 2 — the same passed deadline PLUS a rolling entry: a rolling programme never goes past due.
  { local: "past-fixed-rolling", deadlines: [fixed(ago(10)), rolling()], lastSeenAt: ago(1) },
  // 3 — a future fixed deadline: not a candidate at all, whatever else is true of it.
  {
    local: "future-fixed",
    deadlines: [fixed(ahead(30))],
    nextDeadlineAt: ahead(30),
    lastSeenAt: ago(400),
  },
  // 4 — no deadline of any kind, untouched for 120 days: closed as inactive.
  { local: "no-deadline-idle", deadlines: [], lastSeenAt: ago(120) },
  // 5 — ROLLING-ONLY and untouched for 120 days: closed as inactive. The decision, stated.
  { local: "rolling-idle", deadlines: [rolling()], lastSeenAt: ago(120) },
  // 6 — rolling-only, touched yesterday: stays open. Any publisher write resets this clock.
  { local: "rolling-fresh", deadlines: [rolling()], lastSeenAt: ago(1) },
  // 7 — a stale derived key: one passed fixed date and one still to come. Recomputed, not closed.
  {
    local: "recompute",
    deadlines: [fixed(ago(5)), fixed(ahead(20))],
    nextDeadlineAt: ago(5),
    lastSeenAt: ago(200),
  },
];

function fixed(date: Date): Deadline {
  return { deadlineType: "fixed", date: date.toISOString(), label: "application" };
}
function rolling(): Deadline {
  return { deadlineType: "rolling", label: "application" };
}
const publicId = (local: string) => `${NS}:${local}`;

async function load(local: string): Promise<OpportunityRow> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.publicId, publicId(local)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`fixture ${local} vanished`);
  return row;
}

/** The `close` rows this job wrote for one entry, newest first. */
async function closures(id: number) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectKind, "opportunity"), eq(auditLog.subjectId, id)))
    .orderBy(desc(auditLog.id));
}

const run = describeWithDb;

run("M3JOB scheduled jobs", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let reviewerToken: string;
  let adminKey: string;
  /** `updated_at` as the INSERT left it — nothing this job does may move it. */
  const updatedAtAtInsert = new Map<string, Date>();

  beforeAll(async () => {
    app = await buildApp({ auth: { privy: await testPrivyConfig() } });
    await app.ready();

    const admin = await seedAccount({ did: DIDS.admin, handle: "m3job-admin", role: "admin" });
    await seedAccount({ did: DIDS.reviewer, handle: "m3job-reviewer", role: "reviewer" });
    adminToken = await mintPrivyToken(DIDS.admin);
    reviewerToken = await mintPrivyToken(DIDS.reviewer);
    // An admin's OWN key, with every scope: the point of the 403 below is that a global role never
    // elevates an API key, not that this particular key was under-scoped.
    adminKey = await mintApiKeyFor(admin.id, ["read", "write", "publish"]);

    const inserted = await db
      .insert(opportunities)
      .values(
        FIXTURES.map((fixture) => ({
          publicId: publicId(fixture.local),
          fundingType: "grant" as const,
          status: "open" as const,
          title: `Job fixture ${fixture.local}`,
          description: "A staleness fixture.",
          operatingOrganizations: [{ name: NS, slug: NS }],
          orgSlugs: [NS],
          deadlines: fixture.deadlines,
          nextDeadlineAt: fixture.nextDeadlineAt ?? null,
          lastSeenAt: fixture.lastSeenAt,
          reviewStatus: "approved" as const,
          sourcePublisher: NS,
        })),
      )
      .returning({ publicId: opportunities.publicId, updatedAt: opportunities.updatedAt });
    for (const row of inserted) updatedAtAtInsert.set(row.publicId, row.updatedAt);
  });

  afterAll(async () => {
    await cleanupFixtures({ opportunityPrefix: `${NS}:`, privyDids: Object.values(DIDS) });
    await app.close();
    await pool.end();
  });

  it("closes past-due entries and leaves rolling and future ones open", async () => {
    const first = await runJob("staleness", { now: NOW, maxPasses: 1 });
    expect(first.shape).toBe("cursor");
    expect(first.skipped).toBeUndefined();

    expect((await load("past-fixed")).status).toBe("closed");
    expect((await load("past-fixed-rolling")).status).toBe("open");
    expect((await load("future-fixed")).status).toBe("open");
    expect((await load("rolling-fresh")).status).toBe("open");
  });

  it("closes long-inactive entries, INCLUDING rolling-only ones", async () => {
    expect((await load("no-deadline-idle")).status).toBe("closed");
    expect((await load("rolling-idle")).status).toBe("closed");
  });

  it("recomputes the derived deadline key in the same walk, without closing the entry", async () => {
    const row = await load("recompute");
    expect(row.status).toBe("open");
    expect(row.nextDeadlineAt?.toISOString()).toBe(ahead(20).toISOString());
  });

  it("records each closure as a `close` by the job, naming the reason", async () => {
    for (const [local, reason] of [
      ["past-fixed", "past_due"],
      ["no-deadline-idle", "inactive"],
      ["rolling-idle", "inactive"],
    ] as const) {
      const row = await load(local);
      const rows = (await closures(row.id)).filter((entry) => entry.action === "close");
      expect(rows.length, local).toBe(1);
      const entry = rows[0];
      expect(entry?.actorKind, local).toBe("job");
      expect(entry?.actorAccountId, local).toBeNull();
      expect(entry?.actorApiKeyId, local).toBeNull();
      const patch = entry?.patch as { job?: string; reason?: string };
      expect(patch?.job, local).toBe("staleness");
      expect(patch?.reason, local).toBe(reason);
    }
  });

  it("is idempotent: a second run changes nothing and writes no second closure", async () => {
    const before = await Promise.all(FIXTURES.map((f) => load(f.local)));
    const second = await runJob("staleness", { now: NOW, maxPasses: 1 });
    const after = await Promise.all(FIXTURES.map((f) => load(f.local)));

    expect(after.map((row) => row.status)).toEqual(before.map((row) => row.status));
    expect(after.map((row) => row.nextDeadlineAt?.toISOString() ?? null)).toEqual(
      before.map((row) => row.nextDeadlineAt?.toISOString() ?? null),
    );
    // Whatever else the database contains, this run must not have touched THESE rows again.
    for (const row of after) {
      const rows = (await closures(row.id)).filter((entry) => entry.action === "close");
      expect(rows.length, row.publicId).toBeLessThanOrEqual(1);
    }
    // The run itself still reports a shape and a pass; `processed` may be non-zero if another
    // suite's fixtures are in flight, which is why the assertions above are per-row.
    expect(second.passes).toBe(1);
  });

  /**
   * Two things read `updated_at`, and bumping it breaks both: this job's own inactivity clock is
   * `coalesce(last_seen_at, updated_at)`, and the verification job's predicate is
   * `verified_at < updated_at` — so a close that touched it would re-queue every closed entry for
   * an outbound fetch, every night, forever.
   */
  it("leaves `updated_at` and `last_seen_at` exactly as it found them", async () => {
    for (const fixture of FIXTURES) {
      const row = await load(fixture.local);
      expect(row.updatedAt.toISOString(), fixture.local).toBe(
        updatedAtAtInsert.get(row.publicId)?.toISOString(),
      );
      expect(row.lastSeenAt?.toISOString(), fixture.local).toBe(fixture.lastSeenAt.toISOString());
    }
  });

  it("does not count a candidate the LOCKED re-read finds already resolved", async () => {
    // THE BUG. `settle()`'s closing branch re-reads the row under `FOR UPDATE` — deliberately, so a
    // publisher's write between the walk's SELECT and this lock wins — and its transaction
    // correctly returns early (no update, no audit row) when that re-read no longer agrees the
    // entry should close. But the METHOD used to fall back to the PRE-LOCK `reason` regardless of
    // what the transaction decided, so `runBatch` counted an untouched, still-open entry as
    // processed and closed.
    //
    // A fresh, private fixture (not one of `FIXTURES`, which other cases in this file already
    // drive to `closed`): seeded past due, so the walk's SELECT would capture `reason: "past_due"`,
    // then edited — simulating the concurrent publisher write — to no longer be past due AND to
    // reset the inactivity clock, before the (here, directly invoked) locked re-read runs.
    const localId = "race-resolved";
    const inserted = await db
      .insert(opportunities)
      .values({
        publicId: publicId(localId),
        fundingType: "grant" as const,
        status: "open" as const,
        title: `Job fixture ${localId}`,
        description: "A staleness race fixture.",
        operatingOrganizations: [{ name: NS, slug: NS }],
        orgSlugs: [NS],
        deadlines: [fixed(ago(10))],
        lastSeenAt: ago(1),
        reviewStatus: "approved" as const,
        sourcePublisher: NS,
      })
      .returning();
    const staleSnapshot = inserted[0];
    if (!staleSnapshot) throw new Error("could not seed the race fixture");

    await db
      .update(opportunities)
      .set({ deadlines: [fixed(ahead(30))], lastSeenAt: NOW })
      .where(eq(opportunities.id, staleSnapshot.id));

    const before = await closures(staleSnapshot.id);

    // `settle` is private; this drives it directly rather than orchestrating real overlapping
    // `runBatch` calls, because the property under test — the transaction's OWN outcome must be
    // what is returned — is a property of `settle` itself, not of the page-walking loop around it.
    const service = new StalenessService(db) as unknown as {
      settle(row: OpportunityRow, now: Date, inactiveBefore: Date): Promise<string>;
    };
    const outcome = await service.settle(staleSnapshot, NOW, new Date(NOW.getTime() - 90 * DAY));

    expect(outcome, "the locked re-read's own decision, not the stale pre-lock snapshot's").toBe(
      "unchanged",
    );
    const after = await load(localId);
    expect(after.status).toBe("open");
    expect(await closures(staleSnapshot.id)).toEqual(before);
  });

  it("returns `skipped: locked` — without blocking — while another run holds the lock", async () => {
    const holder = new pg.Client({ connectionString: config.databaseUrl });
    await holder.connect();
    try {
      const key = advisoryLockKey("staleness").toString();
      const taken = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS locked",
        [key],
      );
      expect(taken.rows[0]?.locked).toBe(true);

      // The blocking form would sit here until the `finally` below; the point of `try` is that it
      // comes straight back. Five seconds is far longer than the round trip and far shorter than
      // "forever", so a regression to `pg_advisory_lock` fails rather than hangs the suite.
      const contended = await Promise.race([
        runJob("staleness", { now: NOW }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("blocked")), 5_000)),
      ]);
      expect(contended).toMatchObject({ job: "staleness", skipped: "locked", processed: 0 });
      await holder.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
    } finally {
      await holder.end();
    }
  });

  it("runs a sweep exactly once and reports nothing remaining", async () => {
    // `maxPasses` is deliberately high: the sweep contract is what stops the loop, not the cap.
    const rollup = await runJob("analytics-rollup", { now: NOW, maxPasses: 10 });
    expect(rollup.shape).toBe("sweep");
    expect(rollup.remaining).toBe(0);
    expect(rollup.passes).toBe(1);

    const retention = await runJob("retention", { now: NOW, maxPasses: 10 });
    expect(retention.remaining).toBe(0);
    expect(retention.passes).toBe(1);
  });

  it("reports a feature that is off as skipped, distinctly from the lock", async () => {
    // The two `skipped` values mean opposite things — "nobody configured this" and "somebody else
    // is already doing it" — and a runner that conflated them would report a permanently
    // unconfigured job as healthy contention.
    const enrichment = await runJob("account-enrichment");
    if (config.privy.appSecret) {
      // A developer with real credentials in their environment: the job is enabled, so what this
      // case can still assert is that it did not report the lock.
      expect(enrichment.skipped).not.toBe("locked");
    } else {
      expect(enrichment.skipped).toBe("no identity-provider app secret");
    }
  });

  it("refuses an unknown job name", async () => {
    await expect(runJob("delete-everything")).rejects.toThrow(/unknown job/);
  });

  // ── enrichment ───────────────────────────────────────────────────────────────────
  it("stores the wallet and email the provider holds, and grants nothing by doing so", async () => {
    // `accounts.primary_wallet` is trustworthy precisely because this job is its only writer — a
    // wallet that arrives in a request is self-asserted. What it is NOT is an authorization input
    // in its own right: nothing here promotes anybody, because a role that a column can confer is
    // a role nobody granted. Admins are made by the ceremony or by an admin, never by enrichment.
    const seeded = await seedAccount({ did: DIDS.enriched, handle: "m3job-enriched" });
    expect(seeded.globalRole).toBe("submitter");

    const enrichment = new AccountEnrichmentService(db, {
      config,
      // Only this suite's account is answered for. Every other pending account THROWS, which
      // leaves `enriched_at` NULL and the account exactly as another suite left it — a fixture
      // must not enrich the whole table as a side effect.
      fetchUser: async (did: string) => {
        if (did !== DIDS.enriched) throw new Error("not this suite's account");
        return { primaryWallet: PROVIDER_WALLET, email: null };
      },
    });
    expect((await enrichment.runBatch({ limit: 1000, now: NOW })).processed).toBe(1);

    const enriched = (
      await db.select().from(accounts).where(eq(accounts.privyDid, DIDS.enriched)).limit(1)
    )[0];
    expect(enriched?.primaryWallet).toBe(PROVIDER_WALLET);
    expect(enriched?.enrichedAt).not.toBeNull();
    expect(enriched?.globalRole).toBe("submitter");

    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "account"), eq(auditLog.subjectId, enriched?.id ?? 0)));
    expect(trail.filter((row) => row.action === "assign_role")).toHaveLength(0);
  });

  it("leaves an account in the cursor when its enrichment fails, and finishes it next run", async () => {
    // `enriched_at` is what takes an account OUT of this cursor, so it must not be written by a
    // pass that did not complete: a stamp that outlived a failure means the batch reports the
    // account as failed and nothing ever selects it again.
    const seeded = await seedAccount({ did: DIDS.enrichFailed, handle: "m3job-enrich-failed" });
    expect(seeded.enrichedAt).toBeNull();

    let attempt = 0;
    // Only this suite's account is answered for; every other pending one throws, which leaves it
    // exactly as another suite left it.
    const fetchUser = async (did: string) => {
      if (did !== DIDS.enrichFailed) throw new Error("not this suite's account");
      if (++attempt === 1) throw new Error("the provider call failed");
      return { primaryWallet: PROVIDER_WALLET, email: null };
    };

    const broken = await new AccountEnrichmentService(db, { config, fetchUser }).runBatch({
      limit: 1000,
      now: NOW,
    });
    expect(broken.processed).toBe(0);
    // At least this suite's: the fixture refuses to answer for any other suite's pending account,
    // so in a full run the failure count is however many of those the batch also swept up.
    expect(broken.details?.failed).toBeGreaterThanOrEqual(1);

    const rolledBack = (
      await db.select().from(accounts).where(eq(accounts.privyDid, DIDS.enrichFailed)).limit(1)
    )[0];
    expect(rolledBack?.enrichedAt).toBeNull();
    expect(rolledBack?.primaryWallet).toBeNull();

    // …which is the point: the account is still selected, and the next run completes the work.
    const retried = await new AccountEnrichmentService(db, { config, fetchUser }).runBatch({
      limit: 1000,
      now: NOW,
    });
    expect(retried.processed).toBe(1);

    const settled = (
      await db.select().from(accounts).where(eq(accounts.privyDid, DIDS.enrichFailed)).limit(1)
    )[0];
    expect(settled?.enrichedAt).not.toBeNull();
    expect(settled?.primaryWallet).toBe(PROVIDER_WALLET);
  });

  // ── the convenience route ────────────────────────────────────────────────────────
  it("runs a job for a T4 session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/jobs/retention/run",
      headers: bearer(adminToken),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.job).toBe("retention");
    expect(body.shape).toBe("sweep");
    expect(body.passes).toBe(1);
  });

  it("refuses a reviewer, an API key, and an anonymous caller", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/v1/admin/jobs/retention/run" });
    expect(anonymous.statusCode).toBe(401);

    const reviewer = await app.inject({
      method: "POST",
      url: "/v1/admin/jobs/retention/run",
      headers: bearer(reviewerToken),
      payload: {},
    });
    expect(reviewer.statusCode).toBe(403);

    // An ADMIN's own fully-scoped key. A global role never elevates an API key.
    const key = await app.inject({
      method: "POST",
      url: "/v1/admin/jobs/retention/run",
      headers: bearer(adminKey),
      payload: {},
    });
    expect(key.statusCode).toBe(403);
    expect(key.json().error).toBe("session_required");
  });

  it("400s a job name that is not in the catalogue", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/admin/jobs/rm-rf/run",
      headers: bearer(adminToken),
      payload: {},
    });
    // The route declares the enum, so Fastify refuses it before the controller — which is the
    // right place for it: an unknown name is a malformed request, not a missing resource.
    expect(response.statusCode).toBe(400);
  });
});
