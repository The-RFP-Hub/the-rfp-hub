import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import {
  type VerificationRunInsert,
  type VerificationRunRow,
  verificationRuns,
} from "../../../db/schema.js";

export class VerificationRunRepository {
  constructor(private readonly exec: DbLike) {}

  async insert(values: VerificationRunInsert): Promise<VerificationRunRow | undefined> {
    const rows = await this.exec.insert(verificationRuns).values(values).returning();
    return rows[0];
  }

  /** The newest run for an entry — the one `GET /v1/opportunities/{id}/verification` serves. */
  async latest(opportunityId: number): Promise<VerificationRunRow | undefined> {
    const rows = await this.exec
      .select()
      .from(verificationRuns)
      .where(eq(verificationRuns.opportunityId, opportunityId))
      .orderBy(desc(verificationRuns.runAt), desc(verificationRuns.id))
      .limit(1);
    return rows[0];
  }

  /**
   * RETENTION: keep the newest `keep` runs for each of `opportunityIds`, delete the rest.
   *
   * The run log is otherwise unbounded and each row carries up to 200 KB of `snapshot_text`, so an
   * entry re-checked monthly grows by a couple of megabytes a year for no reader — nobody diffs a
   * page against its state fourteen checks ago. What a reviewer actually opens is the LATEST run,
   * and the handful before it is enough to see "this changed recently".
   *
   * ONE STATEMENT, ranked in the database rather than in this process, so the delete cannot race a
   * run being inserted concurrently into a set of ids read a moment earlier. The ordering is the
   * same `run_at DESC, id DESC` the read path uses, so "the newest `keep`" means the same thing to
   * both — two runs sharing a `run_at` (a hand-triggered check landing in the same millisecond as a
   * job's) are separated by id rather than left to the planner.
   */
  async pruneToLatest(opportunityIds: number[], keep: number): Promise<number> {
    if (opportunityIds.length === 0 || keep < 1) return 0;
    const ranked = this.exec
      .select({
        id: verificationRuns.id,
        rank: sql<number>`row_number() over (
          partition by ${verificationRuns.opportunityId}
          order by ${verificationRuns.runAt} desc, ${verificationRuns.id} desc
        )`.as("rank"),
      })
      .from(verificationRuns)
      .where(inArray(verificationRuns.opportunityId, opportunityIds))
      .as("ranked");

    const doomed = this.exec
      .select({ id: ranked.id })
      .from(ranked)
      .where(sql`${ranked.rank} > ${keep}`);

    const deleted = await this.exec
      .delete(verificationRuns)
      .where(
        and(
          inArray(verificationRuns.opportunityId, opportunityIds),
          inArray(verificationRuns.id, doomed),
        ),
      )
      .returning({ id: verificationRuns.id });
    return deleted.length;
  }
}
