/**
 * Direct database seeding — used only where a real route cannot produce the state a criterion needs.
 *
 * THE RULE THIS FILE OBEYS. Anything the product can create, the product creates: organisations,
 * memberships, verifications, entries and keys all go through real routes in the normal path (see
 * `privy/identities.ts` and the `keyClient` fixture). Direct writes are reserved for two things the
 * API deliberately offers no route for:
 *
 *   - **ageing a fixture backwards.** The staleness criteria need `last_seen_at`/`updated_at` in the
 *     past, and there is no endpoint that moves them there — correctly, because one would be a
 *     route for falsifying history.
 *   - **an API-key credential whose account is fixed and known.** The negative-authentication specs
 *     need a key on an account whose role they chose, without spending a sign-in on it — the
 *     assertions are about the CREDENTIAL KIND, not about identity. The key material below is minted
 *     in the product's own documented format, and every use of it is preceded by a POSITIVE CONTROL:
 *     the key must first be accepted on a route that takes either credential. If this file's format
 *     ever drifts from the API's, that control fails loudly rather than turning the negative
 *     assertion into a vacuous one.
 */
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * The API key token format, mirrored from `packages/api/src/modules/shared/api-key-token.ts`.
 *
 * Mirrored rather than imported: that module lives in another package's `src`, which is not an
 * exported entry point, and reaching across it would couple this suite to a path the API is free to
 * move. The duplication is safe specifically because it is SELF-CHECKING — see the header.
 */
const API_KEY_PREFIX = "rfph_";
const BASE32 = "abcdefghjkmnpqrstvwxyz0123456789";
const PREFIX_LENGTH = 8;
const SECRET_BYTES = 32;

export interface SeededKey {
  token: string;
  prefix: string;
  keyId: number;
  accountId: number;
}

function base32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += BASE32[byte & 31];
  return out;
}

/**
 * An identity and its account, created directly. Returns the account id.
 *
 * TWO ROWS, IN THIS ORDER, and the order is the whole subtlety. `auth_user` is the identity the
 * session library owns; `accounts` is the product's own row and joins to it by `auth_user_id`. There
 * is no foreign key between them — deliberately, because an `accounts` row must outlive a deleted
 * identity, since `audit_log` points at the account and a cascade over there must never be able to
 * erase history over here — so nothing in the database would stop this from creating an orphan. The
 * ordering is what keeps the pair coherent.
 *
 * DIRECT SQL, FOR DETERMINISM. Signing in would produce a real identity, but with an id the library
 * chooses; these rows need an id the caller already knows so a later assertion can name it. It
 * bypasses no hooks, because there are none — the account row is created just-in-time by the API on
 * first `/v1/me`, which is a documented M3 criterion and is precisely why no `databaseHooks` were
 * added on the API side.
 *
 * Idempotent on the identity id.
 */
export async function seedIdentity(
  pool: pg.Pool,
  userId: string,
  email: string,
  role: "submitter" | "reviewer" | "admin" = "submitter",
): Promise<number> {
  await pool.query(
    `INSERT INTO auth_user (id, name, email, email_verified)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
    [userId, email, email.toLowerCase()],
  );

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO accounts (auth_user_id, global_role) VALUES ($1, $2)
       ON CONFLICT (auth_user_id) DO UPDATE SET global_role = EXCLUDED.global_role
       RETURNING id`,
    [userId, role],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error(`db-seed: could not seed an account for ${userId}`);
  return Number(id);
}

/**
 * An API key for an account, in the product's format.
 *
 * Every caller must exercise the key on a route that ACCEPTS keys, and assert that it works, before
 * relying on any refusal made with it — otherwise a refusal proves only that the key was malformed.
 */
export async function seedApiKey(
  pool: pg.Pool,
  accountId: number,
  scopes: Array<"read" | "write" | "publish"> = ["read", "write"],
): Promise<SeededKey> {
  const prefix = base32(PREFIX_LENGTH);
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const token = `${API_KEY_PREFIX}${prefix}_${secret}`;
  const keyHash = createHash("sha256").update(token, "utf8").digest("hex");

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO api_keys (account_id, name, key_prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [accountId, "e2e-seeded", prefix, keyHash, scopes],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error("db-seed: could not seed an API key");
  return { token, prefix, keyId: Number(id), accountId };
}

/**
 * Moves an entry's activity timestamps, and its deadlines, into the past.
 *
 * The only way to produce a stale fixture: `last_seen_at` and `updated_at` are set by the write path
 * and there is no route that moves either backwards.
 *
 * `deadlineDaysFromNow` writes the **`deadlines` document column**, and it must: the staleness job
 * decides from the stored Standard `deadlines[]` array (`staleness.service.ts` → `isPastDue`,
 * `nextDeadlineAt`), not from the derived `next_deadline_at` column, which the job RECOMPUTES from
 * that array on every pass. A fixture that set only the derived column would be overwritten by the
 * job's own recompute and would never close — a test that looked like it was exercising the
 * past-due path while exercising nothing. Both are written here, so the row is coherent either way.
 */
export async function ageEntry(
  pool: pg.Pool,
  publicId: string,
  options: {
    lastSeenDaysAgo?: number;
    updatedDaysAgo?: number;
    /** Days from now for a single fixed deadline; `null` removes every deadline. */
    deadlineDaysFromNow?: number | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [publicId];

  if (options.lastSeenDaysAgo !== undefined) {
    values.push(options.lastSeenDaysAgo);
    sets.push(`last_seen_at = now() - ($${values.length}::int * interval '1 day')`);
  }
  if (options.updatedDaysAgo !== undefined) {
    values.push(options.updatedDaysAgo);
    sets.push(`updated_at = now() - ($${values.length}::int * interval '1 day')`);
  }
  if (options.deadlineDaysFromNow !== undefined) {
    if (options.deadlineDaysFromNow === null) {
      // `deadlines` is NOT NULL with a `[]` default, so "no deadlines" is an empty array.
      sets.push("deadlines = '[]'::jsonb, next_deadline_at = NULL");
    } else {
      const date = new Date(Date.now() + options.deadlineDaysFromNow * 86_400_000).toISOString();
      values.push(JSON.stringify([{ deadlineType: "fixed", date, label: "application" }]));
      sets.push(`deadlines = $${values.length}::jsonb`);
      // The derived column mirrors what `nextDeadlineAt` would compute: the next FUTURE deadline,
      // so a past one leaves it null. The job recomputes it regardless; keeping the row coherent
      // means the list and sort paths see the same thing the job does in the meantime.
      if (options.deadlineDaysFromNow > 0) {
        values.push(date);
        sets.push(`next_deadline_at = $${values.length}::timestamptz`);
      } else {
        sets.push("next_deadline_at = NULL");
      }
    }
  }

  if (sets.length === 0) return;
  await pool.query(`UPDATE opportunities SET ${sets.join(", ")} WHERE public_id = $1`, values);
}
