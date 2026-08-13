/**
 * THE WRITER: the one implementation of the open-data export's PUBLICATION.
 *
 * A run writes the public dataset as JSON + CSV under an output directory, released under CC0-1.0
 * and marked as such both in the JSON envelope and in a LICENSE sidecar written alongside the data.
 * Every run writes six files, in this order:
 *
 *   LICENSE                             the CC0 rights sidecar, written FIRST so no data file is
 *                                       ever readable without its rights notice beside it
 *   opportunities-<date>-<digest>.json  this run's archive, named after a prefix of the sha256
 *   opportunities-<date>-<digest>.csv   of its own bytes
 *   latest.json                         stable names a consumer can hard-code, promoted after the
 *   latest.csv                          archives and staged as a pair, so they never name a
 *                                       half-written dataset, and the window in which they can
 *                                       name two different runs is two adjacent rename(2) calls
 *                                       rather than two file writes
 *   latest.manifest.json                the run's SINGLE authoritative pointer, promoted LAST with
 *                                       ONE rename: a run id, and the href plus full sha256 of
 *                                       both archives
 *
 * The two aliases and the manifest answer different questions, and the difference matters. The
 * aliases are a convenience: two independently named mutable files cannot be replaced as a pair on
 * POSIX, so a consumer fetching both can still, rarely, catch one of each run — a window this code
 * minimizes but cannot eliminate. The MANIFEST is the answer for a consumer that needs the pair to
 * be guaranteed consistent: it is replaced by a single `rename(2)`, so it is never observed
 * half-updated, and everything it names is immutable. Read it once, then fetch the archives it
 * lists, and the pair is provably one run's.
 *
 * A run below EXPORT_MIN_COUNT (default 100) writes NOTHING and exits non-zero: an empty or
 * half-loaded dataset would otherwise quietly replace `latest.*` with a header-only CSV.
 *
 * ── Why this is a module of its own ────────────────────────────────────────────────
 * It takes RECORDS and writes FILES. It opens no connection, reads no configuration and knows
 * nothing about where its input came from, which is what lets two sources publish through it and
 * makes the publication impossible to fork:
 *
 *   export.ts            the DATABASE source — live rows, plus the `dataset_snapshots` row
 *   export-from-api.ts   the API source — a deployed `/v1/` API, no database at all
 *
 * The separation is structural rather than a convention: an export that runs where there is no
 * database must not import one, or a missing DATABASE_URL becomes a startup failure of a run that
 * never needed it.
 *
 * ── Where the FORMAT lives ─────────────────────────────────────────────────────────
 * Not here. The published order, the JSON envelope and the CSV projection are
 * `src/modules/shared/export-format.ts`, because the API SERVES them too: `/v1/export/*` is a live
 * download of the same dataset in the same bytes per record, and a server cannot import a script.
 * What is left here is everything that is about publishing FILES — the digests, the archive names,
 * the CC0 sidecar, the floor, the promotion order and the manifest — none of which a live download
 * has or should have.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_VERSION } from "@the-rfp-hub/standard";
import type { Opportunity } from "@the-rfp-hub/standard";
import {
  EXPORT_LICENSE,
  orderForExport,
  toCsv,
  toExportJson,
} from "../src/modules/shared/export-format.js";

const OUT_DIR = "exports";
const DEFAULT_MIN_COUNT = 100;
/** The single mutable pointer a consumer resolves to get a guaranteed-consistent artifact set. */
export const MANIFEST_NAME = "latest.manifest.json";
const LICENSE_NOTICE = `SPDX-License-Identifier: CC0-1.0

To the extent possible under law, the publisher of this dataset has waived all
copyright and related or neighboring rights to it. This dataset is released under
the Creative Commons CC0 1.0 Universal Public Domain Dedication.

https://creativecommons.org/publicdomain/zero/1.0/legalcode
`;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Archive names carry a prefix of the sha256 of their own bytes, so in practice one name does not
 * designate two different datasets: the name is scoped by UTC date and carries 48 bits of the
 * digest, which puts an accidental same-day collision far outside anything this export will
 * produce. A second run on the same UTC day — a re-run after a partial failure, say — writes its
 * own archive instead of overwriting the first. A re-run over unchanged data rewrites
 * byte-identical content under the same name, which is a no-op. The date stays the readable prefix.
 *
 * A 48-bit content-addressed name, not a storage-enforced write-once guarantee: `write()` does not
 * refuse a colliding name, it just would not be given one.
 */
const archiveName = (date: string, digest: string, ext: string): string =>
  `opportunities-${date}-${digest.slice(0, 12)}.${ext}`;

/** One written file: the name it was written under, and the path it was written to. */
export interface ExportArtifact {
  name: string;
  path: string;
}

/** One immutable archive, as the manifest names it: enough to fetch it and verify what arrived. */
export interface ManifestArtifact {
  format: "json" | "csv";
  /** The archive's filename, relative to the export root the manifest itself was fetched from. */
  href: string;
  /** The FULL sha256 of the bytes stored under `href` — not the 12-hex prefix in the name. */
  sha256: string;
  /** Records in that archive. Identical across formats; carried per-artifact so each is checkable. */
  count: number;
}

/**
 * The run's authoritative description of itself. Promoted with ONE rename, so a consumer never
 * observes it half-updated, and every artifact it names is immutable — which is what makes
 * "these two files are the same run" a thing a consumer can establish rather than assume.
 */
export interface ExportManifest {
  specVersion: string;
  license: string;
  /** Fresh per run. The identity `latest.json` and `latest.csv` cannot carry between them. */
  runId: string;
  generatedAt: string;
  count: number;
  artifacts: ManifestArtifact[];
}

export interface ExportResult {
  count: number;
  /** UTC date stamp used in the archive names. */
  date: string;
  /** Directory the files were written to. */
  outDir: string;
  /** Every file written, in write order. */
  artifacts: ExportArtifact[];
  /** This run's manifest, exactly as published under `latest.manifest.json`. */
  manifest: ExportManifest;
  /**
   * Whether the export directory could actually be fsynced. False means the platform refused to
   * open a directory for fsync, so the names are durable only when the filesystem gets round to
   * them — reported rather than asserted, because the alternative is claiming a durability the run
   * did not obtain.
   */
  directorySynced: boolean;
}

export interface ExportOptions {
  /** Where to write. Defaults to `./exports`. */
  outDir?: string;
  /** Minimum live entries required to publish. Defaults to EXPORT_MIN_COUNT, then 100. */
  minCount?: number;
}

/** Thrown when the dataset is too small to publish. Nothing has been written when it is raised. */
export class ExportFloorError extends Error {
  constructor(
    readonly count: number,
    readonly minCount: number,
  ) {
    super(
      [
        `refusing to publish: ${count} live opportunit${count === 1 ? "y" : "ies"} is below the`,
        `floor of ${minCount}. Nothing was written — the previous export is untouched.`,
        "Check the seed run, or lower EXPORT_MIN_COUNT if a smaller dataset is expected.",
      ].join(" "),
    );
    this.name = "ExportFloorError";
  }
}

/**
 * Thrown when a run fails part-way through writing. Nothing makes six files land atomically, so a
 * partial file set is a state a run really can end in — this names which files were written and
 * which one was not, instead of leaving that to be inferred from a bare write error. It is THROWN
 * rather than returned, which is what keeps a source from recording the run: the database source
 * writes its `dataset_snapshots` row only after the writer returns, so no row ever claims a
 * publication that did not happen.
 *
 * Alias failures are split across two error types: everything before the first rename raises this
 * error with the previous pair intact, and a failure BETWEEN the two renames raises
 * `ExportAliasError`, which is the one case where the pair really can straddle two runs.
 */
export class ExportWriteError extends Error {
  constructor(
    readonly failed: string,
    readonly written: readonly string[],
    override readonly cause: unknown,
  ) {
    super(
      [
        `failed to write ${failed} after writing`,
        written.length > 0 ? written.join(", ") : "nothing",
        "— this run's file set is incomplete and no snapshot row was recorded.",
        "Re-run the export to complete it.",
      ].join(" "),
    );
    this.name = "ExportWriteError";
  }
}

/**
 * Thrown when the alias pair could not be promoted AS A PAIR — the one failure `promoteAliases`
 * stages so carefully to make unreachable, reported loudly rather than folded into a generic write
 * failure. Both payloads were fully written and fsynced and both destinations were checked before
 * either was promoted, so reaching this means a bare `rename(2)` failed with the other alias
 * already in place: `latest.json` and `latest.csv` may now name two different runs. No snapshot row
 * is recorded, and re-running the export repairs the pair.
 */
export class ExportAliasError extends Error {
  constructor(
    readonly failed: string,
    readonly promoted: string,
    override readonly cause: unknown,
  ) {
    super(
      [
        `failed to promote ${failed} after ${promoted} was already promoted —`,
        `${promoted} and ${failed} may now name DIFFERENT runs.`,
        "No snapshot row was recorded. Re-run the export to put the pair back on one run.",
      ].join(" "),
    );
    this.name = "ExportAliasError";
  }
}

function assertFloor(value: number, source: string, raw = String(value)): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${source} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/**
 * The floor, from the explicit option or from EXPORT_MIN_COUNT. BOTH paths are validated here: a
 * caller passing a negative or fractional minimum would otherwise slip past the check the
 * environment variable is held to, and disable the very guard the floor exists to be.
 */
function resolveMinCount(explicit: number | undefined): number {
  if (explicit !== undefined) return assertFloor(explicit, "minCount");
  const raw = process.env.EXPORT_MIN_COUNT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_COUNT;
  return assertFloor(Number(raw), "EXPORT_MIN_COUNT", raw);
}

/**
 * Write `body` to a temp file beside its destination and fsync it, returning the temp path.
 *
 * Beside it, not in the system temp directory: `rename` is only atomic within one filesystem. And
 * fsynced, because promotion has to move bytes that are ALREADY ON DISK — bytes still sitting in a
 * page cache this process may never get to flush are not a payload a rename can be trusted with.
 *
 * This makes the CONTENT durable. The NAME is a separate question, and `syncDir` is what asks it.
 */
async function stageBeside(dir: string, name: string, body: string): Promise<string> {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // `wx`: a name collision is loud rather than a silent overwrite of another run's staging.
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return tmp;
}

/**
 * Errors that mean "this platform will not let a directory be opened and fsynced" rather than
 * "the filesystem failed". Windows refuses the open outright; some filesystems refuse the fsync.
 * Everything NOT in this set — EIO, ENOSPC, EROFS — is a real I/O failure and is propagated: a
 * directory fsync that swallows every error and then reports success is worse than not doing it.
 */
const DIR_SYNC_UNSUPPORTED = new Set([
  "EPERM",
  "EACCES",
  "EISDIR",
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
]);

const unsupported = (err: unknown): boolean =>
  DIR_SYNC_UNSUPPORTED.has((err as NodeJS.ErrnoException)?.code ?? "");

/**
 * fsync a DIRECTORY, so the entries created or replaced inside it survive a crash. A file fsync
 * makes the BYTES durable; only this makes the NAME durable — without it a crash right after a
 * successful export can leave one, both or neither rename applied.
 *
 * Best-effort in one specific, reported sense: returns `false` when the platform does not permit
 * it, and throws when the attempt fails for a reason that is actually about the filesystem. The
 * caller carries the result rather than the prose claiming an fsync that may not have happened.
 *
 * This buys PREFIX durability — the renames are journalled in the order they were issued — and not
 * pair atomicity. A crash-consistent pair and a concurrently-observable pair are different
 * problems; the manifest is the answer to the second one.
 */
async function syncDir(dir: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(dir, "r");
  } catch (err) {
    if (unsupported(err)) return false;
    throw err;
  }
  try {
    await fh.sync();
    return true;
  } catch (err) {
    if (unsupported(err)) return false;
    throw err;
  } finally {
    await fh.close();
  }
}

/**
 * Fail unless `rename` could actually replace `path`. A DIRECTORY is the one entry it cannot:
 * POSIX rename overwrites any other existing file, and an absent destination is the ordinary
 * first-run case. Learning this AFTER the first alias was promoted is precisely the split the
 * staging exists to prevent, so both destinations are checked before either is promoted.
 */
async function assertPromotable(path: string): Promise<void> {
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (info?.isDirectory()) {
    throw Object.assign(new Error(`${path} is a directory, not a file the export can replace`), {
      code: "EISDIR",
    });
  }
}

/**
 * Put `latest.json` and `latest.csv` on this run, narrowing the window in which they can disagree
 * to the gap between two rename(2) calls.
 *
 * Two independently named mutable files cannot be replaced atomically as a pair on POSIX, and no
 * better rename call fixes that — it is a property of the READER's path resolution, not of the
 * writer. What staging buys is a much smaller window and a much better failure mode. Written in
 * sequence, the window is two full file writes and a failure on the second leaves the first already
 * overwritten with no way back. Here both payloads are written to temp files beside their
 * destinations and fsynced FIRST, both destinations are checked, and only then are the renames
 * issued back to back. Every way an alias write realistically fails — a full disk, a read-only
 * directory, a serialization error, a destination that is not a file — now fails while the previous
 * pair is still whole and nothing has been promoted; the temps are removed and the run raises
 * `ExportWriteError`. What remains between the two renames is a pair of metadata operations on
 * bytes already fsynced, in a directory whose own fsync has been attempted, onto destinations
 * already checked, and a failure even there is not silent:
 * it is `ExportAliasError`.
 *
 * The residual window is minimized, not eliminated. `latest.manifest.json` is what eliminates it,
 * by being a set of ONE: a single rename has no gap to observe.
 *
 * Exported because it carries the guarantee on its own and is tested on its own: a full export can
 * only be made to fail one alias by making that alias's destination unusable, which destroys the
 * very file a test of the pair has to read back.
 */
export async function promoteAliases(
  outDir: string,
  aliases: readonly { name: string; body: string }[],
  written: readonly string[],
): Promise<ExportArtifact[]> {
  const staged: { name: string; tmp: string }[] = [];
  const discard = async (): Promise<void> => {
    await Promise.all(staged.map(({ tmp }) => rm(tmp, { force: true })));
  };

  let pending = "";
  try {
    for (const { name, body } of aliases) {
      pending = name;
      staged.push({ name, tmp: await stageBeside(outDir, name, body) });
    }
    // The temps' own directory entries, made durable before a rename is asked to move them.
    pending = outDir;
    await syncDir(outDir);
    for (const { name } of aliases) {
      pending = name;
      await assertPromotable(join(outDir, name));
    }
  } catch (err) {
    await discard();
    throw new ExportWriteError(pending, written, err);
  }

  const promoted: ExportArtifact[] = [];
  for (const { name, tmp } of staged) {
    const path = join(outDir, name);
    try {
      await rename(tmp, path);
    } catch (err) {
      const done = promoted.map((p) => p.name);
      // Nothing promoted yet, so the previous pair is untouched: an ordinary failed write.
      if (done.length === 0) {
        await discard();
        throw new ExportWriteError(name, written, err);
      }
      throw new ExportAliasError(name, done.join(", "), err);
    }
    promoted.push({ name, path });
  }
  // The renames themselves, made durable. Prefix durability, in issue order — not pair atomicity.
  await syncDir(outDir);
  return promoted;
}

/**
 * Serialize `items` and publish the six-file set — or write nothing at all.
 *
 * Every source goes through here, so the digests, the floor and the promotion order have exactly
 * one implementation between them, over payloads produced by the one shared format module. Purely
 * a filesystem operation: it takes records, not a connection.
 */
export async function writeExport(
  items: readonly Opportunity[],
  options: ExportOptions = {},
): Promise<ExportResult> {
  const minCount = resolveMinCount(options.minCount);
  const outDir = options.outDir ?? OUT_DIR;

  // Floor first: assert BEFORE anything is serialized or written, so a short run can never clobber
  // `latest.*` or leave a truncated archive behind.
  if (items.length < minCount) throw new ExportFloorError(items.length, minCount);

  const generatedAt = new Date().toISOString();
  const date = generatedAt.slice(0, 10);

  // The published order and both serializations, from the shared format module — the same three
  // calls the live `/v1/export/*` routes make, which is what makes an archive and a live download
  // byte-identical per record.
  const ordered = orderForExport(items);
  const json = toExportJson(ordered, generatedAt);
  const csv = toCsv(ordered);
  const jsonDigest = sha256(json);
  const csvDigest = sha256(csv);

  await mkdir(outDir, { recursive: true });
  const artifacts: ExportArtifact[] = [];
  const write = async (name: string, body: string): Promise<string> => {
    const path = join(outDir, name);
    try {
      await writeFile(path, body);
    } catch (err) {
      throw new ExportWriteError(
        name,
        artifacts.map((a) => a.name),
        err,
      );
    }
    artifacts.push({ name, path });
    return path;
  };

  // Rights sidecar first: its content is constant, so re-writing it every run is idempotent, and
  // going first means no data file is ever readable without it. Then the archive, then the aliases
  // that point at it — a run that dies part-way leaves `latest.*` on the last COMPLETE dataset
  // rather than on a partially-written one. The aliases go through `promoteAliases`, which lands
  // them as a pair or not at all.
  await write("LICENSE", LICENSE_NOTICE);
  const jsonName = archiveName(date, jsonDigest, "json");
  const csvName = archiveName(date, csvDigest, "csv");
  await write(jsonName, json);
  await write(csvName, csv);
  // The archives' names, made durable BEFORE anything points at them: no pointer this run publishes
  // should be able to outlive the entries it names.
  const directorySynced = await syncDir(outDir);
  artifacts.push(
    ...(await promoteAliases(
      outDir,
      [
        { name: "latest.json", body: json },
        { name: "latest.csv", body: csv },
      ],
      artifacts.map((a) => a.name),
    )),
  );

  // The manifest goes LAST and alone. Its rename is the instant this run becomes published: one
  // metadata operation, so no consumer can observe it half-updated, and everything it names was on
  // disk and fsynced before it was issued. `promoteAliases` with a set of one is exactly that —
  // staged, destination checked, one rename, and a failure raises `ExportWriteError` with the
  // previous manifest still whole.
  const manifest: ExportManifest = {
    specVersion: SPEC_VERSION,
    license: EXPORT_LICENSE,
    runId: randomBytes(16).toString("hex"),
    generatedAt,
    count: ordered.length,
    artifacts: [
      { format: "json", href: jsonName, sha256: jsonDigest, count: ordered.length },
      { format: "csv", href: csvName, sha256: csvDigest, count: ordered.length },
    ],
  };
  artifacts.push(
    ...(await promoteAliases(
      outDir,
      [{ name: MANIFEST_NAME, body: `${JSON.stringify(manifest, null, 2)}\n` }],
      artifacts.map((a) => a.name),
    )),
  );

  return { count: ordered.length, date, outDir, artifacts, manifest, directorySynced };
}
