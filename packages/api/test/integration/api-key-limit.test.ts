/**
 * The 25-live-key ceiling under concurrency.
 *
 * `ApiKeyService#create` used to count an account's live keys and open its insert transaction as
 * two separate steps, which made the ceiling a check-then-act race: two concurrent mints at 24
 * live keys could both observe 24, both decide "under the limit", and both insert — landing the
 * account on 26. The fix locks the account row (`SELECT … FOR UPDATE`) INSIDE the same transaction
 * that counts and inserts, so a second concurrent caller blocks at the lock and re-counts only
 * after the first one's insert (or rollback) is visible to it.
 *
 * This suite drives the race at the SERVICE layer — bypassing the `POST /v1/keys` route's 10/min
 * rate limit entirely — because the property under test is a database-level serialization
 * guarantee, not anything HTTP-shaped.
 *
 * Isolation tag: `M3KEYLIMIT` / `m3keylimit:`.
 */
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "../../src/db/client.js";
import { apiKeys, auditLog } from "../../src/db/schema.js";
import { ApiKeyService } from "../../src/modules/services/auth/api-key.service.js";
import { isHttpError } from "../../src/modules/shared/http-error.js";
import { mintApiKeyFor, seedAccount } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { describeWithDb } from "./db-gate.js";

const DID = "did:privy:m3keylimit-account";
const LIVE_BEFORE_THE_RACE = 24;
const MAX_LIVE_KEYS = 25;

const run = describeWithDb;

run("M3KEYLIMIT the 25-live-key ceiling holds under a concurrent mint", () => {
  let accountId: number;

  beforeAll(async () => {
    const account = await seedAccount({ did: DID, handle: "m3keylimit-account" });
    accountId = account.id;

    // Seeded directly through the fixture helper (a plain INSERT), not through the service under
    // test — the race is in `create()`, and reaching 24 live keys is setup, not the assertion.
    for (let i = 0; i < LIVE_BEFORE_THE_RACE; i++) {
      await mintApiKeyFor(accountId);
    }
  });

  afterAll(async () => {
    await cleanupFixtures({ privyDids: [DID] });
  });

  it("lets exactly one of two concurrent mints through the 25th slot", async () => {
    const svc = new ApiKeyService(db);

    const results = await Promise.allSettled([
      svc.create(accountId, { name: "racer-a" }),
      svc.create(accountId, { name: "racer-b" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0];
    if (failure?.status !== "rejected") throw new Error("expected a rejection");
    expect(isHttpError(failure.reason)).toBe(true);
    if (isHttpError(failure.reason)) {
      expect(failure.reason.status).toBe(400);
      expect(failure.reason.code).toBe("too_many_keys");
    }

    const live = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.accountId, accountId), isNull(apiKeys.revokedAt)));
    expect(live).toHaveLength(MAX_LIVE_KEYS);
  });
});

/**
 * `ApiKeyService#revoke` used to read `revoked_at` in one statement and unconditionally set it in
 * another: two concurrent revocations of the SAME key both read `null`, both updated (the second
 * blocking on the row lock and then overwriting the first's timestamp once it committed), and BOTH
 * appended a `revoke_api_key` audit row claiming `before: null` — two revocations of one key in a
 * history that can hold only one. The fix moves the check into the UPDATE's own WHERE
 * (`revoked_at IS NULL`), so only the winner's statement matches a row; the loser falls through to
 * the documented re-revocation no-op and audits nothing.
 *
 * Isolation tag: `M3KEYREVOKE` / `m3keyrevoke:`.
 */
const REVOKE_DID = "did:privy:m3keyrevoke-account";

run("M3KEYREVOKE a key's revocation is a single, once-only event under concurrency", () => {
  let accountId: number;
  let keyId: number;

  beforeAll(async () => {
    const account = await seedAccount({ did: REVOKE_DID, handle: "m3keyrevoke-account" });
    accountId = account.id;
    await mintApiKeyFor(accountId);
    const rows = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.accountId, accountId));
    const seeded = rows[0];
    if (!seeded) throw new Error("could not seed the key under test");
    keyId = seeded.id;
  });

  afterAll(async () => {
    await cleanupFixtures({ privyDids: [REVOKE_DID] });
  });

  it("writes exactly one audit row and one stable `revokedAt` for two concurrent revokes", async () => {
    const svc = new ApiKeyService(db);

    const [first, second] = await Promise.all([
      svc.revoke(accountId, keyId),
      svc.revoke(accountId, keyId),
    ]);

    // Neither call throws — re-revoking an already-revoked key is a documented no-op, not a race
    // one side of it loses visibly.
    expect(first.revokedAt).not.toBeNull();
    expect(second.revokedAt).not.toBeNull();
    // Both calls report the SAME winning timestamp: the loser returned the winner's row rather
    // than a second, later one of its own.
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectKind, "api_key"),
          eq(auditLog.subjectId, keyId),
          eq(auditLog.action, "revoke_api_key"),
        ),
      );
    expect(rows).toHaveLength(1);

    const stored = (await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1))[0];
    expect(stored?.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
  });
});
