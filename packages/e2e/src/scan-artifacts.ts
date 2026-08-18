/**
 * The end-of-run secret scan over everything Playwright wrote.
 *
 * WHEN IT RUNS, AND WHY THAT IS THE ONLY WORKABLE TIME. In the external runner's `finally`, AFTER
 * the Playwright child has exited. A trace is a zip that Playwright finalises when the test that
 * produced it ends; a spec cannot scan its own unfinished trace, and a Playwright reporter runs
 * before the last artifacts are flushed. So the scan belongs to the process that outlives all of
 * them.
 *
 * WHAT IT GUARANTEES, STATED PRECISELY. *No LONG-LIVED secret appears in any artifact.* That means
 * the identity app secret, the one-time code, and every `rfph_…` API key this run minted — the
 * material that still has value tomorrow. It is NOT a claim that no secret of any kind is present:
 * Playwright records request headers itself and offers no redaction hook, so short-lived (~1 h)
 * access tokens DO appear inside failure traces. That residue is stated here, in the README and in
 * the report rather than quietly excluded from the scan's wording.
 *
 * A hit is a run failure and a reported security defect, not a warning.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { inflateRawSync } from "node:zlib";
import { longLived } from "./redact.js";

export interface ScanHit {
  /** Path relative to the scan root. */
  file: string;
  /** The zip member, when the hit was inside a trace. */
  member?: string;
  /** What leaked, by label. NEVER the value. */
  label: string;
}

export interface ScanResult {
  filesScanned: number;
  zipMembersScanned: number;
  secretsSearchedFor: number;
  hits: ScanHit[];
  /** Files that could not be read or decompressed — named and counted, never silently dropped. */
  unreadable: string[];
}

/** Extensions read as text. Everything else is either a zip (handled) or genuinely opaque. */
const TEXT_LIKE = new Set([
  ".txt",
  ".log",
  ".json",
  ".md",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".map",
  ".xml",
  ".csv",
  ".yml",
  ".yaml",
  ".ndjson",
  "",
]);

const ZIP_LIKE = new Set([".zip"]);

/**
 * Scans every root for every long-lived secret this run registered.
 *
 * The secret list comes from the FILE-BACKED registry (`redact.ts`), which is the whole reason that
 * registry is file-backed: a key minted inside a Playwright worker is in no other process's memory,
 * and a scanner that searched only its own heap would report "clean" about exactly the material
 * most likely to have leaked.
 */
export function scan(roots: string[]): ScanResult {
  const secrets = longLived().filter((secret) => secret.value.length >= 8);
  const result: ScanResult = {
    filesScanned: 0,
    zipMembersScanned: 0,
    secretsSearchedFor: secrets.length,
    hits: [],
    unreadable: [],
  };

  if (secrets.length === 0) return result;

  for (const root of roots) {
    for (const file of walk(root)) {
      const extension = extname(file).toLowerCase();
      const rel = relative(root, file) || file;

      if (ZIP_LIKE.has(extension)) {
        try {
          for (const member of zipMembers(readFileSync(file))) {
            result.zipMembersScanned++;
            for (const secret of secrets) {
              if (member.content.includes(secret.value)) {
                result.hits.push({ file: rel, member: member.name, label: secret.label });
              }
            }
          }
          result.filesScanned++;
        } catch (err) {
          result.unreadable.push(`${rel}: ${(err as Error).message}`);
        }
        continue;
      }

      if (!TEXT_LIKE.has(extension)) {
        // Binary artifacts (screenshots, videos) cannot embed a header string in a way a substring
        // search would find, but they are COUNTED as unreadable rather than dropped from the
        // denominator — a "clean" result has to say what it did not look at.
        result.unreadable.push(`${rel}: not scanned (${extension || "no extension"})`);
        continue;
      }

      try {
        const content = readFileSync(file, "utf8");
        result.filesScanned++;
        for (const secret of secrets) {
          if (content.includes(secret.value)) {
            result.hits.push({ file: rel, label: secret.label });
          }
        }
      } catch (err) {
        result.unreadable.push(`${rel}: ${(err as Error).message}`);
      }
    }
  }

  return result;
}

function* walk(root: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // A root that was never created (no failures, no traces) is not a problem.
  }
  for (const entry of entries) {
    const full = join(root, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (stats.isFile()) {
      yield full;
    }
  }
}

// ── a minimal zip reader ───────────────────────────────────────────────────────────────────────
//
// Traces are zips, and a scanner that skipped them would be skipping the artifact most likely to
// contain a credential. Rather than shelling out to `unzip` — which may not exist, and whose
// absence would silently shrink what the scan covered — the archive is read directly.
//
// The CENTRAL DIRECTORY is parsed, not the local headers: a streaming writer is entitled to leave
// the compressed size out of a local header and put it in a trailing data descriptor, so local
// headers alone cannot be walked reliably. The central directory always carries real sizes and the
// offset of each local header.

interface ZipMember {
  name: string;
  content: string;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function* zipMembers(buffer: Buffer): Generator<ZipMember> {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("no end-of-central-directory record (not a zip, or truncated)");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`central directory entry ${index} has a bad signature`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      yield { name, content: raw.toString("utf8") };
    } else if (method === 8) {
      yield { name, content: inflateRawSync(raw).toString("utf8") };
    }
    // Any other method is a compression this reader does not implement; it is reported by the
    // caller through `unreadable` only if the whole archive fails, so a single exotic member is
    // skipped. Playwright writes deflate and stored, so this is a theoretical branch.

    offset += 46 + nameLength + extraLength + commentLength;
  }
}

/** Finds the EOCD record by scanning backwards — its position depends on the trailing comment. */
function findEocd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let index = buffer.length - 22; index >= minimum; index--) {
    if (buffer.readUInt32LE(index) === EOCD_SIGNATURE) return index;
  }
  return -1;
}

/** A one-line summary for the console and the report. Names labels, never values. */
export function describeScan(result: ScanResult): string {
  if (result.secretsSearchedFor === 0) {
    return "artifact scan: nothing to search for (no long-lived secret was registered this run)";
  }
  const base =
    `artifact scan: ${result.filesScanned} file(s) + ${result.zipMembersScanned} archive member(s), ` +
    `${result.secretsSearchedFor} long-lived secret(s) searched for`;
  if (result.hits.length === 0) {
    const skipped = result.unreadable.length ? `, ${result.unreadable.length} not read` : "";
    return `${base} — clean${skipped}`;
  }
  const labels = [...new Set(result.hits.map((hit) => hit.label))].join(", ");
  return `${base} — ${result.hits.length} HIT(S) [${labels}]`;
}
