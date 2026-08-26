/**
 * The IMPORT path's history — the one write path that used to leave none.
 *
 * The seed loader upserts `opportunities` straight from a curated corpus, outside the submission
 * flow and its authorization model. That made it the only mutation in the product with no
 * `audit_log` row, so an entry loaded from the corpus — which is most of the corpus — answered
 * `GET /v1/opportunities/:id/audit` with an empty trail while `docs/data-model.md` promised that
 * every write is audited.
 *
 * Four properties, and all four matter:
 *
 *   1. a first import leaves a `create` row attributed to the SYSTEM, naming the path and the
 *      source system it came from;
 *   2. re-importing the SAME document leaves nothing — the seed re-runs whenever the corpus file
 *      moves, and `audit_log` is append-only, so a no-op row per entry per run is a mess nobody can
 *      clean up afterwards;
 *   3. re-importing a CHANGED document leaves an `update` row that names the fields that moved;
 *   4. and "changed" includes the three things the IMPORT decides and no route audits for it —
 *      `review_status`, `is_listed`, `source_system`. Unpublishing the whole corpus by re-importing
 *      it as pending must not pass as a no-op just because the documents' text was untouched.
 *
 * Then migration `0010`, which gives the create row to the entries imported before any of this
 * existed — including the ones that were approved or edited afterwards and so have history without
 * having an origin. It is asserted from the migration file itself rather than from a transcription,
 * and inside a transaction that is rolled back — the statement is corpus-wide by design, and a test
 * running beside other suites against a shared database has no business committing it.
 *
 * Isolation tag: `M3IMPORT` / `m3import:`.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Opportunity } from "@the-rfp-hub/standard";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db, pool } from "../../src/db/client.js";
import { auditLog, opportunities, organizations } from "../../src/db/schema.js";
import { fromStandard } from "../../src/modules/mappers/opportunity.mapper.js";
import { AuditRepository } from "../../src/modules/repositories/index.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m3import";
const SEEDED = `${NS}:seeded`;
const ORPHAN = `${NS}:orphan`;
const ATOMIC = `${NS}:atomic`;
const ATOMIC_ORG = `${NS}-atomic-org`;

const MIGRATION = fileURLToPath(
  new URL("../../src/db/migrations/0010_audit_backfill_import.sql", import.meta.url),
);

const run = describeWithDb;
const ingest = new OpportunityService();

/** A corpus document, varied one field at a time — the same shape the seed loader hands over. */
function corpusDocument(id: string, over: Record<string, unknown> = {}): Opportunity {
  return submission(id, NS, over as never) as unknown as Opportunity;
}

function importOf(
  std: Opportunity,
  over: {
    reviewStatus?: "pending" | "approved" | "rejected";
    isListed?: boolean;
    sourceSystem?: string;
  } = {},
): Promise<void> {
  return ingest.upsertFromStandard(std, {
    reviewStatus: "approved",
    isListed: true,
    sourceSystem: NS,
    ...over,
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

/** Thrown to roll the migration cases back; caught by name so a real failure still propagates. */
class Rollback extends Error {}

/**
 * An opportunity row of exactly the pre-fix shape: written by the import path, carrying no history.
 *
 * Inserted through the repository's plain `insert` rather than through the service, because the
 * service is the thing that now writes the audit row — the fixture has to be what the OLD code
 * produced, not what the new code produces.
 */
async function insertUnaudited(exec: Executor, publicId: string) {
  const { opp } = fromStandard(corpusDocument(publicId));
  const rows = await exec
    .insert(opportunities)
    .values({
      ...opp,
      sourceSystem: NS,
      reviewStatus: "approved",
      isListed: true,
      updatedAt: new Date(),
    })
    .returning();
  const row = rows[0];
  expect(row, `the ${publicId} fixture was not inserted`).toBeDefined();
  if (!row) throw new Rollback();
  return row;
}

run("M3IMPORT the corpus import writes history", () => {
  beforeAll(async () => {
    await cleanupFixtures({ opportunityPrefix: NS, organizationSlugs: [NS, ATOMIC_ORG] });
  });

  afterAll(async () => {
    await cleanupFixtures({ opportunityPrefix: NS, organizationSlugs: [NS, ATOMIC_ORG] });
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
    // `job` is the only bare value; everything else, `sourceSystem` included, is a before/after
    // pair, so one key never has to mean two shapes.
    expect(row?.patch).toMatchObject({ job: "import", sourceSystem: { after: NS } });
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
      title: { before: `Fixture ${SEEDED}`, after: "Renamed by the corpus" },
    });
    // Unchanged fields stay out, `source_system` included — it is only in the patch when it moved.
    expect(latest?.patch).not.toHaveProperty("sourceSystem");
  });

  it("records a re-import that only changed a decision the import path itself makes", async () => {
    const id = await rowIdOf(SEEDED);
    const before = await trailOf(db, id);

    // The document is byte-identical; only `review_status` and `is_listed` move. Nothing else
    // audits those on this path — there is no reviewer and no route behind a corpus file — so if
    // the import's own diff ignored them, unpublishing the whole corpus would leave no trace.
    await importOf(corpusDocument(SEEDED, { title: "Renamed by the corpus" }), {
      reviewStatus: "pending",
      isListed: false,
    });

    const rows = await trailOf(db, id);
    expect(rows).toHaveLength(before.length + 1);
    const latest = rows.at(-1);
    expect(latest?.action).toBe("update");
    expect(latest?.patch).toMatchObject({
      job: "import",
      reviewStatus: { before: "approved", after: "pending" },
      isListed: { before: true, after: false },
    });
    // …and only those: an unchanged document must not drag its own text into the patch.
    expect(latest?.patch).not.toHaveProperty("title");

    // Put it back, and that is a second change with a second row.
    await importOf(corpusDocument(SEEDED, { title: "Renamed by the corpus" }));
    expect(await trailOf(db, id)).toHaveLength(before.length + 2);
  });

  it("records a re-import that only moved the entry to another source system", async () => {
    const id = await rowIdOf(SEEDED);
    const before = await trailOf(db, id);

    // Byte-identical document — same title, same review decision, same listing flag — with only
    // the `sourceSystem` OPTION moved to a different importer.
    await importOf(corpusDocument(SEEDED, { title: "Renamed by the corpus" }), {
      sourceSystem: `${NS}-alt`,
    });

    const rows = await trailOf(db, id);
    expect(rows).toHaveLength(before.length + 1);
    const latest = rows.at(-1);
    expect(latest?.action).toBe("update");
    expect(latest?.actorKind).toBe("job");
    expect(latest?.patch).toMatchObject({
      job: "import",
      sourceSystem: { before: NS, after: `${NS}-alt` },
    });
    // The document's own content never moved, so it must not ride along in the patch.
    expect(latest?.patch).not.toHaveProperty("title");
    expect(latest?.patch).not.toHaveProperty("description");

    // Put the source system back so later assertions in this file see what they expect.
    await importOf(corpusDocument(SEEDED, { title: "Renamed by the corpus" }));
    expect(await trailOf(db, id)).toHaveLength(before.length + 2);
  });

  it("backfills an entry whose only history is what happened to it AFTER the import", async () => {
    const statements = await backfillStatements();

    try {
      await db.transaction(async (tx) => {
        const orphan = await insertUnaudited(tx, `${NS}:approved-only`);
        // Exactly the shape the first predicate missed: imported before the fix, then approved by a
        // reviewer. It HAS history — it just has nothing saying where it came from, and it is the
        // entry somebody is most likely to open the trail of.
        await tx.insert(auditLog).values({
          subjectKind: "opportunity",
          subjectId: orphan.id,
          actorKind: "job",
          action: "approve",
          patch: { reviewStatus: { before: "pending", after: "approved" } },
        });
        expect(await trailOf(tx, orphan.id)).toHaveLength(1);

        for (const statement of statements) await tx.execute(sql.raw(statement));

        const rows = await trailOf(tx, orphan.id);
        expect(rows.map((row) => row.action).sort()).toEqual(["approve", "create"]);
        expect(rows.find((row) => row.action === "create")?.patch).toMatchObject({
          backfill: true,
          job: "import",
          sourceSystem: NS,
        });

        // Still idempotent now that the marker is `create` rather than "any row".
        for (const statement of statements) await tx.execute(sql.raw(statement));
        expect(await trailOf(tx, orphan.id)).toHaveLength(2);

        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
  });

  it("backfills exactly the entries whose appearance was never recorded, idempotently (migration 0010)", async () => {
    const statements = await backfillStatements();
    expect(statements).toHaveLength(1);

    const audited = await rowIdOf(SEEDED);
    const auditedBefore = (await trailOf(db, audited)).length;

    try {
      await db.transaction(async (tx) => {
        const orphan = await insertUnaudited(tx, ORPHAN);
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

        // And an entry that already recorded its own appearance keeps exactly the history it had —
        // inventing a second origin for a row that has one is worse than leaving it alone.
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

  it("rolls back the opportunity and organization writes when the audit insert fails", async () => {
    // A NEW public id under a NEW organization slug — neither can already have a row from an
    // earlier test in this file, so their absence afterwards can only mean the transaction rolled
    // back cleanly rather than one of these tests having tidied up first.
    const std = corpusDocument(ATOMIC, {
      operatingOrganizations: [{ name: ATOMIC_ORG, slug: ATOMIC_ORG }],
    });

    const failure = new Error("m3import: injected audit insert failure");
    const record = vi.spyOn(AuditRepository.prototype, "record").mockImplementationOnce(() => {
      throw failure;
    });

    try {
      await expect(importOf(std)).rejects.toBe(failure);
    } finally {
      record.mockRestore();
    }

    // The organization upsert and the opportunity upsert both ran, inside the same transaction as
    // the audit insert that then failed — ATOMIC means neither survives without it.
    const opportunityRows = await db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(eq(opportunities.publicId, ATOMIC));
    expect(opportunityRows).toHaveLength(0);

    const organizationRows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, ATOMIC_ORG));
    expect(organizationRows).toHaveLength(0);
  });
});
