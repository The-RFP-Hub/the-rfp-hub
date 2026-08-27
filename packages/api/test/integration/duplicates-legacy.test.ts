/**
 * The two things the duplicates outage was actually made of, against a real database.
 *
 * Isolation tag: `M3LEGACY` / `m3legacy:`.
 *
 * `GET /v1/opportunities/{id}/duplicates` answered 500 in production for every entry in the
 * corpus. The deployed schema was missing `opportunity_duplicates.rules_key`, so the read failed
 * in the SELECT, before a row was ever mapped — which is why entries with no pairs at all failed
 * too. Two independent defects put it there and both are covered here:
 *
 *   1. THE MIGRATION COULD NOT BE APPLIED. 0011 was regenerated in place after an earlier form of
 *      it had already run somewhere, and the regeneration moved the journal's `when`. Drizzle
 *      compares that `when` with `created_at` in `drizzle.__drizzle_migrations`, so the database
 *      carrying the old 0011 was offered the new one and aborted on `ADD COLUMN "signal"` —
 *      already there. The migration runs in a transaction, so nothing landed, `rules_key` never
 *      appeared, and every later `pnpm migrate` failed on the same statement.
 *
 *   2. THE READ DEPENDED ON A COLUMN IT DOES NOT RENDER. `test/unit/duplicate-pair-read-columns`
 *      holds that invariant where it is observable — in the SQL. What is left for a database is
 *      the other half: that a pair recorded before any of these columns existed still renders.
 *
 * The first test EXECUTES the migration's own statements against a schema that already has them.
 * That is the exact situation the deployed database is in, and post-fix every statement is a
 * no-op, which is why running it against the shared integration database is safe: nothing it does
 * changes a column, a row or a lock anyone else's suite depends on.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeWithDb } from "./db-gate.js";

const { buildApp } = await import("../../src/app.js");
const { db, pool } = await import("../../src/db/client.js");
const { opportunities } = await import("../../src/db/schema.js");
const { cleanupFixtures } = await import("../helpers/cleanup.js");

const NS = "m3legacy";
const MIGRATION = fileURLToPath(
  new URL("../../src/db/migrations/0011_hybrid_duplicate_overlap.sql", import.meta.url),
);

/** The statements drizzle would run, split exactly the way its migrator splits them. */
const statementsOf = (file: string): string[] =>
  readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const insertOpportunity = async (suffix: string): Promise<number> => {
  const rows = await db
    .insert(opportunities)
    .values({
      publicId: `${NS}:${suffix}`,
      fundingType: "grant",
      status: "open",
      title: `M3LEGACY ${suffix}`,
      description: "An entry whose duplicate pair predates the overlap arm.",
      operatingOrganizations: [{ name: "M3LEGACY fixture", slug: NS }],
      ecosystems: ["M3LEGACY"],
      reviewStatus: "approved",
      isListed: true,
    })
    .returning({ id: opportunities.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`failed to insert ${suffix}`);
  return id;
};

describeWithDb(
  "M3LEGACY the duplicate read against a database that predates the overlap arm",
  () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      await cleanupFixtures({ opportunityPrefix: NS });
      await app.close();
      await pool.end();
    });

    /**
     * DEFECT 1, and the only test that can catch it: a migration is only ever run once by the tool
     * that owns it, so nothing else notices when it stops being runnable a second time.
     *
     * Against the generated form of 0011 this fails with
     * `column "signal" of relation "opportunity_duplicates" already exists` — which is verbatim the
     * error that left production without `rules_key`.
     */
    it("re-applies 0011 to a schema that already carries it", async () => {
      for (const statement of statementsOf(MIGRATION)) {
        await db.execute(sql.raw(statement));
      }

      const columns = await db.execute(sql`
        select column_name
          from information_schema.columns
         where table_name = 'opportunity_duplicates'
           and column_name in ('signal', 'rules_key', 'rules_version')
      `);
      const names = columns.rows.map((row) => String(row.column_name)).sort();
      // `rules_version` is the column the superseded form of 0011 added; re-applying retires it.
      expect(names).toEqual(["rules_key", "signal"]);
    });

    /**
     * DEFECT 2's remaining half. A pair written before `signal`, `rules_key` and a recorded
     * similarity existed is the ordinary shape of the rows already in the corpus, and the published
     * component promises it renders: `similarity: null` and `matchedOn: []` — "no reasons recorded",
     * never an absent field and never a crash.
     */
    it("serves a pair recorded before the overlap arm, without inventing reasons for it", async () => {
      const left = await insertOpportunity("left");
      const right = await insertOpportunity("right");
      // Written through raw SQL on purpose: the point is a row with NONE of the columns the current
      // detector writes, which the typed insert has no way to express.
      await db.execute(sql`
        insert into opportunity_duplicates (opportunity_id, duplicate_of_id, similarity, status)
        values (${Math.min(left, right)}, ${Math.max(left, right)}, null, 'suspected')
      `);

      const response = await app.inject({
        method: "GET",
        url: `/v1/opportunities/${NS}:left/duplicates`,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        items: [
          {
            id: `${NS}:right`,
            title: "M3LEGACY right",
            isPublic: true,
            similarity: null,
            matchedOn: [],
            status: "suspected",
            detectedAt: expect.any(String),
          },
        ],
      });
    });
  },
);
