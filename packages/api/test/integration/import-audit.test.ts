/**
 * The IMPORT path's history — the one write path that used to leave none.
 *
 * The seed loader upserts `opportunities` straight from a curated corpus, outside the submission
 * flow and its authorization model. That made it the only mutation in the product with no
 * `audit_log` row, so an entry loaded from the corpus — which is most of the corpus — answered
 * `GET /v1/opportunities/:id/audit` with an empty trail while `docs/data-model.md` promised that
 * every write is audited.
 *
 * Three properties, and all three matter:
 *
 *   1. a first import leaves a `create` row attributed to the SYSTEM, naming the path and the
 *      source system it came from;
 *   2. re-importing the SAME document leaves nothing — the seed re-runs whenever the corpus file
 *      moves, and `audit_log` is append-only, so a no-op row per entry per run is a mess nobody can
 *      clean up afterwards;
 *   3. re-importing a CHANGED document leaves an `update` row that names the fields that moved.
 *
 * The fourth case is migration `0010`, which gives the same row to the entries imported before any
 * of this existed. It is asserted from the migration file itself rather than from a transcription,
 * and inside a transaction that is rolled back — the statement is corpus-wide by design, and a test
 * running beside other suites against a shared database has no business committing it.
 *
 * Isolation tag: `M3IMPORT` / `m3import:`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db, pool } from "../../src/db/client.js";
import { auditLog, opportunities } from "../../src/db/schema.js";
import { fromStandard } from "../../src/modules/mappers/opportunity.mapper.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3import";
const SEEDED = `${NS}:seeded`;
const ORPHAN = `${NS}:orphan`;

const MIGRATION = fileURLToPath(
  new URL("../../src/db/migrations/0010_audit_backfill_import.sql", import.meta.url),
);

const run = describeWithDb;
const ingest = new OpportunityService();

/** A corpus document, varied one field at a time — the same shape the seed loader hands over. */
function corpusDocument(id: string, over: Record<string, unknown> = {}): Opportunity {
  return submission(id, NS, over as never) as unknown as Opportunity;
}

function importOf(std: Opportunity): Promise<void> {
  return ingest.upsertFromStandard(std, {
    reviewStatus: "approved",
    isListed: true,
    sourceSystem: NS,
  });
}

/** Executor-agnostic so the migration case can read its own uncommitted rows. */
type Executor = Pick<typeof db, "select" | "execute" | "insert">;

async function trailOf(exec: Executor, subjectId: number) {
  return exec
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectKind, "opportunity"), eq(auditLog.subjectId, subjectId)))
    .orderBy(asc(auditLog.id));
}

async function rowIdOf(publicId: string): Promise<number> {
  const rows = await db
    .select({ id: opportunities.id })
    .from(opportunities)
    .where(eq(opportunities.publicId, publicId));
  const id = rows[0]?.id;
  expect(id, `no opportunity row for ${publicId}`).toBeDefined();
  return id as number;
}

/**
 * The migration's statements, read from the file that will actually run.
 *
 * Transcribing them here would prove only that two copies of the SQL agree with each other; reading
 * the file makes a drift between what is asserted and what ships a test failure.
 */
async function backfillStatements(): Promise<string[]> {
  const text = await readFile(MIGRATION, "utf8");
  return text
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((chunk) => chunk.length > 0);
}

/** Thrown to roll the migration case back; caught by name so a real failure still propagates. */
class Rollback extends Error {}

run("M3IMPORT the corpus import writes history", () => {
  beforeAll(async () => {
    await cleanupFixtures({ opportunityPrefix: NS, organizationSlugs: [NS] });
  });

  afterAll(async () => {
    await cleanupFixtures({ opportunityPrefix: NS, organizationSlugs: [NS] });
    await pool.end();
  });

  it("records a first import as a system `create` naming the path and the source system", async () => {
    await importOf(corpusDocument(SEEDED));

    const rows = await trailOf(db, await rowIdOf(SEEDED));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.action).toBe("create");
    // Nobody's behalf: there is no account behind a corpus file, and inventing one would be worse
    // than the missing row this replaces.
    expect(row?.actorKind).toBe("job");
    expect(row?.actorAccountId).toBeNull();
    expect(row?.actorApiKeyId).toBeNull();
    expect(row?.patch).toMatchObject({ job: "import", sourceSystem: NS });
    // A create diffs against nothing, so the document itself is in the patch.
    expect(row?.patch).toHaveProperty("title");
  });

  it("adds nothing when the same document is imported again", async () => {
    const id = await rowIdOf(SEEDED);
    const before = await trailOf(db, id);

    // The upsert still runs and still moves `updated_at`, `last_seen_at` and `next_deadline_at` —
    // all server bookkeeping. If any of them counted as content, a nightly re-import would report
    // the whole corpus as edited nightly, forever, in a table nothing can delete from.
    await importOf(corpusDocument(SEEDED));

    expect(await trailOf(db, id)).toHaveLength(before.length);
  });

  it("records a content-changing re-import as an `update` naming the fields that moved", async () => {
    const id = await rowIdOf(SEEDED);
    const before = await trailOf(db, id);

    await importOf(corpusDocument(SEEDED, { title: "Renamed by the corpus" }));

    const rows = await trailOf(db, id);
    expect(rows).toHaveLength(before.length + 1);
    const latest = rows.at(-1);
    expect(latest?.action).toBe("update");
    expect(latest?.actorKind).toBe("job");
    expect(latest?.patch).toMatchObject({
      job: "import",
      sourceSystem: NS,
      title: { before: `Fixture ${SEEDED}`, after: "Renamed by the corpus" },
    });
  });

  it("backfills exactly the entries with no history at all, idempotently (migration 0010)", async () => {
    const statements = await backfillStatements();
    expect(statements).toHaveLength(1);

    const audited = await rowIdOf(SEEDED);
    const auditedBefore = (await trailOf(db, audited)).length;

    try {
      await db.transaction(async (tx) => {
        // An entry of exactly the pre-fix shape: a row written by the import path, no history.
        const { opp } = fromStandard(corpusDocument(ORPHAN));
        const inserted = await tx
          .insert(opportunities)
          .values({
            ...opp,
            sourceSystem: NS,
            reviewStatus: "approved",
            isListed: true,
            updatedAt: new Date(),
          })
          .returning();
        const orphan = inserted[0];
        expect(orphan, "the orphan fixture was not inserted").toBeDefined();
        if (!orphan) throw new Rollback();
        expect(await trailOf(tx, orphan.id)).toHaveLength(0);

        for (const statement of statements) await tx.execute(sql.raw(statement));

        const rows = await trailOf(tx, orphan.id);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.action).toBe("create");
        expect(row?.actorKind).toBe("job");
        expect(row?.actorRole).toBeNull();
        expect(row?.patch).toMatchObject({ backfill: true, job: "import", sourceSystem: NS });
        // Stamped with the row's own creation time, not the deploy's: the trail is ordered by
        // `created_at`, and "now" would file every entry's origin after every later decision.
        expect(row?.createdAt.toISOString()).toBe(orphan.createdAt.toISOString());

        // Idempotent: the predicate now sees the row it just wrote.
        for (const statement of statements) await tx.execute(sql.raw(statement));
        expect(await trailOf(tx, orphan.id)).toHaveLength(1);

        // And an entry that already has history keeps exactly the history it had — inventing an
        // origin story for a row that has one is worse than leaving it alone.
        expect(await trailOf(tx, audited)).toHaveLength(auditedBefore);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    // Nothing committed: the statement is corpus-wide, and other suites share this database.
    const survivors = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.publicId, ORPHAN));
    expect(survivors).toHaveLength(0);
  });
});
