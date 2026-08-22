/**
 * What two writers do to each other, and what a revocation does to a write already in flight.
 *
 * Both are scheduled rather than raced: a barrier connection holds the row the write path must lock
 * (`test/helpers/lock-barrier.ts`), the requests queue behind it in the database's own wait queue,
 * and the test says when they are released. Nothing here repeats an operation hoping to catch an
 * interleaving — the interleaving is chosen.
 *
 * Isolation tag: `M3CONC` / `m3conc:`.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { accounts, auditLog, opportunities } from "../../src/db/schema.js";
import { translateWriteFailure } from "../../src/modules/services/opportunities/opportunity-write.service.js";
import { type HttpError, isHttpError } from "../../src/modules/shared/http-error.js";
import {
  bearer,
  grantMembership,
  mintApiKeyFor,
  seedIdentity,
  seedOrganization,
  testAuth,
} from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { openLockBarrier } from "../helpers/lock-barrier.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3conc";
const EMAILS = {
  publisher: "m3conc-publisher@rfphub.invalid",
  /** Publishes here through an admin grant rather than a membership — the other route to T2. */
  direct: "m3conc-direct@rfphub.invalid",
};

/** One `{before, after}` entry of an audit patch. */
interface Change {
  before: unknown;
  after: unknown;
}

const run = describeWithDb;

run("M3CONC concurrent writes", () => {
  let app: FastifyInstance;
  let publisherToken: string;
  let directKey: string;
  let accountId: number;
  let directAccountId: number;
  let organizationId: number;
  const userIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();

    const publisher = await seedIdentity(EMAILS.publisher, { handle: "m3conc-publisher" });
    const direct = await seedIdentity(EMAILS.direct, {
      handle: "m3conc-direct",
      directCreate: true,
    });
    userIds.push(publisher.userId, direct.userId);
    const organization = await seedOrganization({ slug: NS, verified: true });
    await grantMembership(publisher.account.id, organization.id);
    accountId = publisher.account.id;
    directAccountId = direct.account.id;
    organizationId = organization.id;
    publisherToken = publisher.token;
    directKey = await mintApiKeyFor(direct.account.id, ["read", "write", "publish"]);
  }, 30_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      userIds,
      emails: Object.values(EMAILS),
    });
    await app.close();
    await pool.end();
  }, 30_000);

  const document = (id: string, marker: string) =>
    submission(id, NS, {
      title: `Entry ${marker}`,
      description: `Body ${marker}`,
      ecosystems: ["M3CONC"],
    });

  const create = async (id: string, token = publisherToken) =>
    app.inject({
      method: "POST",
      url: "/v1/opportunities",
      headers: bearer(token),
      payload: document(id, "as submitted"),
    });

  const replace = async (id: string, marker: string, token = publisherToken) =>
    app.inject({
      method: "PUT",
      url: `/v1/opportunities/${id}`,
      headers: bearer(token),
      payload: document(id, marker),
    });

  const storedRow = async (id: string) =>
    (await db.select().from(opportunities).where(eq(opportunities.publicId, id)).limit(1))[0];

  /** The `update` trail for one entry, oldest first — the order the writes committed in. */
  const updatePatches = async (opportunityId: number) => {
    const rows = await db
      .select({ patch: auditLog.patch })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "opportunity"),
          eq(auditLog.subjectId, opportunityId),
          eq(auditLog.action, "update"),
        ),
      )
      .orderBy(auditLog.id);
    return rows.map((row) => row.patch ?? {});
  };

  it("chains the audit patches of two replacements that were in flight together", async () => {
    const id = `${NS}:chained`;
    expect((await create(id)).statusCode).toBe(201);

    const barrier = await openLockBarrier();
    const both = [] as ReturnType<typeof replace>[];
    try {
      await barrier.run("select id from opportunities where public_id = $1 for update", [id]);
      // Started, not awaited: each one runs until it needs the row this barrier holds. Waiting for
      // the block between the two is what fixes their order without asking either to be slow.
      both.push(replace(id, "first"));
      await barrier.waitForWaiters(1);
      both.push(replace(id, "second"));
      await barrier.waitForWaiters(2);
    } finally {
      await barrier.rollback();
    }
    for (const response of await Promise.all(both)) {
      expect(response.statusCode, response.body).toBe(200);
    }

    const stored = await storedRow(id);
    if (!stored) throw new Error(`${id} was not stored`);
    const patches = await updatePatches(stored.id);
    expect(patches).toHaveLength(2);

    // THE ASSERTION THAT MATTERS. Each patch must start where the previous one ended: a writer that
    // diffed against a snapshot taken before the other writer committed would record a `before` the
    // row never held at that point, and the trail would describe a history that did not happen.
    const [earlier, later] = patches.map((patch) => ({
      title: patch.title as Change,
      description: patch.description as Change,
    }));
    if (!earlier || !later) throw new Error("expected two update patches");
    expect(earlier.title.after).toBe(later.title.before);
    expect(earlier.description.after).toBe(later.description.before);

    // …and the row itself is the end of that chain, whole: both fields come from the SAME writer,
    // never one field from each.
    expect(stored.title).toBe(later.title.after);
    expect(stored.description).toBe(later.description.after);
    expect(["Entry first", "Entry second"]).toContain(stored.title);
    expect(stored.description).toBe(stored.title.replace("Entry ", "Body "));
  }, 30_000);

  it("lands a replacement pending when the membership is revoked before it commits", async () => {
    const id = `${NS}:revoked`;
    expect((await create(id)).statusCode).toBe(201);
    expect((await storedRow(id))?.reviewStatus).toBe("approved");

    const barrier = await openLockBarrier();
    let replaced: Awaited<ReturnType<typeof replace>>;
    try {
      // Uncommitted: the membership row is locked by the barrier, not yet gone.
      await barrier.run(
        "delete from org_memberships where account_id = $1 and organization_id = $2",
        [accountId, organizationId],
      );
      const pending = replace(id, "after the revocation");
      // The write can only block here because it re-proves its authority INSIDE its transaction.
      // A path that trusted the memberships resolved at authentication time would never touch this
      // row, so this wait is itself the regression assertion.
      await barrier.waitForWaiters(1);
      await barrier.commit();
      replaced = await pending;
    } finally {
      await barrier.rollback();
      await grantMembership(accountId, organizationId);
    }

    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().reviewStatus).toBe("pending");

    const stored = await storedRow(id);
    expect(stored?.reviewStatus).toBe("pending");
    // The entry left the public reads with it, and the trail says why.
    expect(stored?.isListed).toBe(true);
    expect((await app.inject({ method: "GET", url: `/v1/opportunities/${id}` })).statusCode).toBe(
      404,
    );
    const reasons = (await updatePatches(stored?.id ?? 0)).map((patch) => patch.reason);
    expect(reasons).toContain("replaced_without_auto_approval");
  }, 30_000);

  it("keeps a replacement approved when the revocation racing it rolls back", async () => {
    const id = `${NS}:kept`;
    expect((await create(id)).statusCode).toBe(201);

    const barrier = await openLockBarrier();
    let replaced: Awaited<ReturnType<typeof replace>>;
    try {
      await barrier.run(
        "delete from org_memberships where account_id = $1 and organization_id = $2",
        [accountId, organizationId],
      );
      const pending = replace(id, "while a revocation was open");
      await barrier.waitForWaiters(1);
      // The same interleaving, with the other outcome: a revocation that never commits took nothing
      // away, so the write that waited for it publishes exactly as it would have alone.
      await barrier.rollback();
      replaced = await pending;
    } finally {
      await barrier.rollback();
    }

    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().reviewStatus).toBe("approved");
    expect((await storedRow(id))?.reviewStatus).toBe("approved");
    expect((await app.inject({ method: "GET", url: `/v1/opportunities/${id}` })).statusCode).toBe(
      200,
    );
  }, 30_000);

  it("lands a replacement pending when the organisation is un-verified before it commits", async () => {
    // The membership survives this one untouched: what is taken away is the VERIFICATION that makes
    // it a publishing membership. Locking the membership row alone would leave this race open.
    const id = `${NS}:unverified`;
    expect((await create(id)).statusCode).toBe(201);

    const barrier = await openLockBarrier();
    let replaced: Awaited<ReturnType<typeof replace>>;
    try {
      await barrier.run("update organizations set verified = false where id = $1", [
        organizationId,
      ]);
      const pending = replace(id, "after the organisation was un-verified");
      await barrier.waitForWaiters(1);
      await barrier.commit();
      replaced = await pending;
    } finally {
      await barrier.rollback();
      await seedOrganization({ slug: NS, verified: true });
    }

    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().reviewStatus).toBe("pending");
    expect((await storedRow(id))?.reviewStatus).toBe("pending");
  }, 30_000);

  it("lands a replacement pending when the direct-create grant is revoked before it commits", async () => {
    // This account holds no membership at all: its authority here is the admin grant, so the
    // `accounts` row is the only thing to lock and the whole decision hangs off it.
    //
    // Deliberately an API KEY rather than a session. Resolving a session re-provisions the account
    // through an `INSERT … ON CONFLICT DO NOTHING`, which waits on any uncommitted update of that
    // row — so a session would stall at authentication and reach the write with the revocation
    // already visible, whatever the write path did. A key is verified with a plain read, so the
    // only thing that can see the revocation is the locked read inside the transaction.
    const id = `${NS}:granted`;
    expect((await create(id, directKey)).statusCode).toBe(201);
    expect((await storedRow(id))?.reviewStatus).toBe("approved");

    const barrier = await openLockBarrier();
    let replaced: Awaited<ReturnType<typeof replace>>;
    try {
      await barrier.run("update accounts set direct_create = false where id = $1", [
        directAccountId,
      ]);
      const pending = replace(id, "after the grant was revoked", directKey);
      await barrier.waitForWaiters(1);
      await barrier.commit();
      replaced = await pending;
    } finally {
      await barrier.rollback();
      await db.update(accounts).set({ directCreate: true }).where(eq(accounts.id, directAccountId));
    }

    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json().reviewStatus).toBe("pending");
    expect((await storedRow(id))?.reviewStatus).toBe("pending");
  }, 30_000);

  it("turns the public-id unique violation into a 409, against the constraint the database has", async () => {
    // The answer the create/create race depends on, and the one no other test reaches: two creates
    // of the same absent id both pass the `FOR UPDATE` lookup — PostgreSQL does not lock a row that
    // is not there — and the loser's INSERT raises 23505. Translating that to `409 id_conflict`
    // means matching a constraint NAME, so this drives a real violation of the real constraint
    // rather than a hand-written error object: rename it in a migration and this fails, which is
    // the only way the match can be kept honest.
    const first = `${NS}:conflict-a`;
    const second = `${NS}:conflict-b`;
    expect((await create(first)).statusCode).toBe(201);
    expect((await create(second)).statusCode).toBe(201);

    const violation = await db
      .update(opportunities)
      .set({ publicId: first })
      .where(eq(opportunities.publicId, second))
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(violation, "the collision did not raise").toBeDefined();

    const translated = translateWriteFailure(violation, { id: first } as Opportunity);
    expect(isHttpError(translated)).toBe(true);
    expect((translated as HttpError).status).toBe(409);
    expect((translated as HttpError).code).toBe("id_conflict");
  }, 30_000);
});
