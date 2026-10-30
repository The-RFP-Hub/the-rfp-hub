/**
 * THE EARLIEST INACTIVITY CLOSES — an exact top-N over a stream read in clock order.
 *
 * The "closing soon" list must be the `limit` listings the staleness job closes FIRST. The database
 * can order by the inactivity clock but not by the projected close (`inactivityClosesAt` reads the
 * deadlines array, and re-implementing that parse in SQL would be a second copy of the rule that
 * could disagree with the job on an undated or unparseable entry). A cap on rows read in clock
 * order, then sorted, is wrong: two thousand old listings whose deadlines postpone them can fill the
 * cap ahead of a newer one that closes tomorrow.
 *
 * WHAT MAKES AN EARLY STOP EXACT. Every projected close is `>= clock + days` (`inactivityClosesAt`
 * says so and its tests pin it). Rows arrive in ascending clock order, so `clock + days` of the next
 * row is a lower bound on every close not yet seen. Once that bound is past the horizon, or past the
 * close of the (`limit` + 1)-th best kept so far, no unseen row can enter the answer or change
 * whether there are more than `limit` — and the walk stops. The `+ 1` is what makes `truncated`
 * ("more than `limit` close in the window") exact rather than a guess.
 *
 * KEYSET, NOT OFFSET. The reader resumes after `(clockKey, id)`, where `clockKey` is the clock as
 * the database prints it: `updated_at` carries microseconds a JS `Date` cannot hold, so a cursor
 * rebuilt from a `Date` would compare below the row it came from.
 *
 * `scanCap` is a SAFETY bound on rows examined, far above any realistic backlog. If it is reached
 * before the stop condition, the answer is reported `complete: false` and the caller must say so;
 * it is never presented as the soonest of everything.
 */
import {
  type StalenessFacts,
  inactivityClockOf,
  inactivityClosesAt,
} from "../../shared/staleness.js";

export interface ClockCursor {
  clockKey: string;
  id: number;
}

export interface ClockedCandidate<T> {
  row: T;
  clockKey: string;
}

export type CandidatePageReader<T> = (
  after: ClockCursor | null,
  size: number,
) => Promise<ClockedCandidate<T>[]>;

export interface EarliestClosings<T> {
  /** At most `limit`, by projected close then id. */
  due: { row: T; closesAt: Date }[];
  /** More than `limit` close inside the window. Exact when `complete`. */
  truncated: boolean;
  /** False only when `scanCap` stopped the walk before the answer was proven. */
  complete: boolean;
}

export async function earliestInactivityClosings<
  T extends StalenessFacts & { id: number },
>(options: {
  readPage: CandidatePageReader<T>;
  now: Date;
  /** The window's end, epoch ms. */
  horizon: number;
  inactiveDays: number;
  limit: number;
  pageSize: number;
  scanCap: number;
}): Promise<EarliestClosings<T>> {
  const { readPage, now, horizon, inactiveDays, limit, pageSize, scanCap } = options;
  const floorOf = (row: T) => inactivityClockOf(row).getTime() + inactiveDays * 86_400_000;
  // The best `limit + 1` seen so far, kept sorted.
  const kept: { row: T; closesAt: Date }[] = [];
  const keep = limit + 1;
  let scanned = 0;
  let after: ClockCursor | null = null;

  for (;;) {
    const size = Math.min(pageSize, scanCap - scanned);
    if (size <= 0) return finish(false);
    const page = await readPage(after, size);
    for (const { row } of page) {
      const floor = floorOf(row);
      if (floor > horizon) return finish(true);
      const last = kept[keep - 1];
      if (last !== undefined && floor > last.closesAt.getTime()) return finish(true);
      const closesAt = inactivityClosesAt(row, now, inactiveDays);
      if (closesAt === null || closesAt.getTime() > horizon) continue;
      insertSorted(kept, { row, closesAt });
      if (kept.length > keep) kept.pop();
    }
    scanned += page.length;
    if (page.length < size) return finish(true);
    const tail = page[page.length - 1] as ClockedCandidate<T>;
    after = { clockKey: tail.clockKey, id: tail.row.id };
  }

  function finish(complete: boolean): EarliestClosings<T> {
    return { due: kept.slice(0, limit), truncated: kept.length > limit, complete };
  }
}

function insertSorted<T extends { id: number }>(
  list: { row: T; closesAt: Date }[],
  entry: { row: T; closesAt: Date },
): void {
  const at = list.findIndex(
    (other) =>
      other.closesAt.getTime() > entry.closesAt.getTime() ||
      (other.closesAt.getTime() === entry.closesAt.getTime() && other.row.id > entry.row.id),
  );
  if (at === -1) list.push(entry);
  else list.splice(at, 0, entry);
}
