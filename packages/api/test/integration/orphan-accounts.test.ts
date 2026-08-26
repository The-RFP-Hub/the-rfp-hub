/**
 * What migration 0006 does to the accounts it orphans — and why doing nothing was not an option.
 *
 * Every `accounts` row that existed before the identity swap lost its join key: nobody can ever
 * authenticate as one again. Left alone that is not merely inert, it is two live hazards:
 *
 *   1. an orphaned ADMIN still satisfies the last-admin guard, so the product believes it has a
 *      working administrator that cannot sign in — a lockout that looks healthy from the inside;
 *   2. an orphaned account's API KEYS are still live credentials. Key verification never consults
 *      the identity column, so a bearer of one keeps full access to an account whose owner can no
 *      longer be authenticated at all.
 *
 * The migration's data section closes both. This file asserts it against rows of exactly that
 * shape, by running the same statements the migration ships — the file is read from disk rather
 * than restated here, so a drift between what is asserted and what will run is a failure.
 *
 * Isolation tag: `M3ORPHAN` / handles `m3orphan-*`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type DB, db, pool } from "../../src/db/client.js";
import { accounts, apiKeys, auditLog } from "../../src/db/schema.js";
import { repositories } from "../../src/modules/repositories/index.js";
import { AdminService } from "../../src/modules/services/admin/admin.service.js";
import { mintApiKey } from "../../src/modules/shared/api-key-token.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const HANDLES = { admin: "m3orphan-admin", live: "m3orphan-live" };
const ALL_HANDLES = [
  ...Object.values(HANDLES),
  "m3orphan-admin-grant",
  "m3orphan-admin-two",
  "m3orphan-live-real",
];

const MIGRATION = path.join(
  fileURLToPath(new URL("../../src/db/migrations/", import.meta.url)),
  "0006_better_auth.sql",
);

/**
 * The DATA half of 0006, lifted out of the migration itself.
 *
 * Taken from the file rather than transcribed: a test that restates the statements it is asserting
 * proves only that two copies agree with each other. The DDL half is skipped by starting at the
 * marker the migration writes for exactly this purpose.
 */
async function dataSection(): Promise<string[]> {
  const sqlText = await readFile(MIGRATION, "utf8");
  const marker = sqlText.indexOf("-- ── DATA:");
  expect(marker, "the migration no longer carries a DATA section marker").toBeGreaterThan(0);
  return sqlText
    .slice(marker)
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((statement) => statement !== "");
}

const run = describeWithDb;

run("M3ORPHAN the pre-identity accounts", () => {
  let statements: string[];

  beforeAll(async () => {
    statements = await dataSection();
    expect(statements.length).toBeGreaterThanOrEqual(1);
    await cleanupFixtures({ handles: ALL_HANDLES });
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({ handles: ALL_HANDLES });
    await pool.end();
  }, 60_000);

  /** An account of the PRE-migration shape: privileged, credentialed, and unreachable. */
  async function seedOrphan(handle: string) {
    const rows = await db
      .insert(accounts)
      .values({
        // NULL is the whole point: this row's identity column was never filled, which is the state
        // the migration leaves every pre-existing row in.
        authUserId: null,
        handle,
        globalRole: "admin",
        directCreate: true,
      })
      .returning();
    const account = rows[0];
    if (!account) throw new Error("could not seed an orphan");
    const minted = mintApiKey();
    await db.insert(apiKeys).values({
      accountId: account.id,
      name: "orphan",
      keyPrefix: minted.prefix,
      keyHash: minted.keyHash,
      scopes: ["read", "write", "publish"],
    });
    // A history row, so the "the rows STAY" half of the policy has something to be about.
    await repositories(db).audit.record({
      subjectKind: "account",
      subjectId: account.id,
      actorKind: "user",
      actorAccountId: account.id,
      action: "assign_role",
      patch: { globalRole: { before: "submitter", after: "admin" } },
    });
    return account;
  }

  const applyDataSection = async () => {
    for (const statement of statements) await db.execute(sql.raw(statement));
  };

  it("strips the privileges off an account nobody can sign into, and revokes its keys", async () => {
    const orphan = await seedOrphan(HANDLES.admin);
    const auditBefore = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "account"), eq(auditLog.subjectId, orphan.id)));
    expect(auditBefore.length).toBeGreaterThan(0);

    await applyDataSection();

    const after = (await db.select().from(accounts).where(eq(accounts.id, orphan.id)))[0];
    expect(after?.globalRole).toBe("submitter");
    // Independent of the role, and a privilege in its own right: publish into ANY namespace.
    expect(after?.directCreate).toBe(false);

    const keys = await db.select().from(apiKeys).where(eq(apiKeys.accountId, orphan.id));
    expect(keys.length).toBe(1);
    expect(keys[0]?.revokedAt).not.toBeNull();

    // THE ROWS STAY. `audit_log` points at `accounts.id`, so deleting an orphan would either break
    // that reference or force history to be deleted with it — which is the one thing this repo's
    // append-only trail may never do.
    const auditAfter = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectKind, "account"), eq(auditLog.subjectId, orphan.id)));
    expect(auditAfter.length).toBe(auditBefore.length);
  }, 60_000);

  it("is idempotent, and leaves a live account alone", async () => {
    // A signed-in account, i.e. one with an identity: the predicate must not touch it.
    const live = (
      await db
        .insert(accounts)
        .values({
          authUserId: `m3orphan-subject-${Date.now()}`,
          handle: HANDLES.live,
          globalRole: "admin",
          directCreate: true,
        })
        .returning()
    )[0];
    if (!live) throw new Error("could not seed a live account");

    await applyDataSection();
    await applyDataSection();

    const after = (await db.select().from(accounts).where(eq(accounts.id, live.id)))[0];
    expect(after?.globalRole).toBe("admin");
    expect(after?.directCreate).toBe(true);
    // A second pass changes nothing about the orphans either — the predicate no longer matches them.
    const stillOrphaned = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(isNull(accounts.authUserId), eq(accounts.globalRole, "admin")));
    expect(stillOrphaned).toEqual([]);
  }, 60_000);

  it("refuses to grant anything to an account with no identity, but still allows cleanup", async () => {
    // The migration clears the orphans that EXIST; this is what stops the product from making new
    // ones. Without it an admin could re-promote an unreachable row through the ordinary route and
    // recreate the exact hazard — a phantom administrator that satisfies the last-admin guard.
    const orphan = await seedOrphan(`${HANDLES.admin}-grant`);
    await applyDataSection();
    const admins = new AdminService(db);

    for (const role of ["admin", "reviewer"] as const) {
      await expect(admins.assignRole(orphan.id, orphan.id, role)).rejects.toMatchObject({
        status: 409,
        code: "unreachable_account",
      });
    }
    await expect(admins.setDirectCreate(orphan.id, orphan.id, true)).rejects.toMatchObject({
      status: 409,
      code: "unreachable_account",
    });

    // CLEANUP STAYS POSSIBLE, deliberately. Refusing the demotion direction as well would strand a
    // phantom admin — one created before this rule existed, or by a direct database write — as a
    // permanent entry in the count the last-admin guard reads.
    await db
      .update(accounts)
      .set({ globalRole: "admin", directCreate: true })
      .where(eq(accounts.id, orphan.id));
    const demoted = await admins.assignRole(orphan.id, orphan.id, "submitter");
    expect(demoted.globalRole).toBe("submitter");
    const revoked = await admins.setDirectCreate(orphan.id, orphan.id, false);
    expect(revoked.directCreate).toBe(false);
  }, 60_000);

  it("stops an orphan from satisfying the last-admin guard", async () => {
    // The lockout this policy exists to prevent, asserted through the guard itself: with one real
    // admin and one orphaned admin, demoting the real one must be REFUSED before the data section
    // runs (the guard counts two) and refused after it as well (the guard counts one — the orphan
    // no longer being an admin is what makes that the truth rather than an accident).
    //
    // Arranged inside a transaction that is rolled back: the admin count is a fact about the whole
    // database, and other suites keep their own admins in it.
    const rollback = new Error("rollback the arrangement");
    await expect(
      db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ globalRole: "submitter" })
          .where(eq(accounts.globalRole, "admin"));

        const real = (
          await tx
            .insert(accounts)
            .values({
              authUserId: `m3orphan-real-${Date.now()}`,
              handle: `${HANDLES.live}-real`,
              globalRole: "admin",
            })
            .returning()
        )[0];
        const orphan = (
          await tx
            .insert(accounts)
            .values({ authUserId: null, handle: `${HANDLES.admin}-two`, globalRole: "admin" })
            .returning()
        )[0];
        if (!real || !orphan) throw new Error("could not arrange the guard case");

        const admins = new AdminService(tx as unknown as DB);
        // Two admins as far as the guard can see — so this is allowed, and that is the bug.
        const demoted = await admins.assignRole(real.id, real.id, "submitter");
        expect(demoted.globalRole).toBe("submitter");
        await tx.update(accounts).set({ globalRole: "admin" }).where(eq(accounts.id, real.id));

        // …now apply the policy, and the guard sees the truth.
        for (const statement of statements) await tx.execute(sql.raw(statement));
        await expect(admins.assignRole(real.id, real.id, "submitter")).rejects.toMatchObject({
          status: 409,
          code: "last_admin",
        });

        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }, 60_000);
});
