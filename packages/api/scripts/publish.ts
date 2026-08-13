/**
 * Publish a finished open-data export to an object store: read the export directory, resolve the
 * manifest the run left behind, and upload the six files it names — in the writer's own order.
 *
 * This runs AFTER `pnpm export` and shares nothing with it but a directory. It reads no database,
 * serializes nothing, and derives no name of its own: the archive filenames come out of
 * `latest.manifest.json`, because the manifest is what that run published as its own description
 * of itself. Re-deriving them from today's date and a digest would be a second implementation of
 * the writer's naming rule, and a publish step that disagrees with the manifest it is uploading is
 * exactly the failure this design exists to make impossible.
 *
 * The upload order MIRRORS the writer's, and for the same reason:
 *
 *   LICENSE                             the CC0 sidecar, first, so no data object is ever
 *                                       readable without its rights notice beside it
 *   opportunities-<date>-<digest>.json  the immutable archives, before anything points at them
 *   opportunities-<date>-<digest>.csv
 *   latest.json                         the stable aliases
 *   latest.csv
 *   latest.manifest.json                the single authoritative pointer, LAST
 *
 * Sequential and fail-fast. A bucket has no `rename(2)` and no way to replace two keys together,
 * so the ORDER is the whole guarantee: a run that dies part-way has not replaced the manifest, and
 * a consumer following the documented contract — resolve the pointer once, fetch what it names,
 * verify the digests — still gets the previous run, whole. The archives it names are
 * content-addressed, so a partial publish cannot have overwritten them either. What a partial
 * publish CAN leave straddling two runs is the `latest.*` alias pair, which is the same caveat
 * the local writer carries and the same reason the manifest exists.
 *
 * Nothing here sets an ACL. Public read is a property of the BUCKET POLICY, granted once where the
 * bucket is created; the identity this script runs as needs `s3:PutObject` and nothing more. On a
 * bucket with ownership enforced, an ACL flag is not merely redundant — it is rejected outright.
 *
 * Configuration is environment-only, and no bucket name is committed anywhere in this repo:
 *
 *   S3_BUCKET    required. The bucket NAME — not a URI, not a path.
 *   S3_PREFIX    optional key prefix, default empty. Slashes are normalized.
 *   AWS_REGION   optional. Unset falls through to the SDK's own default chain.
 *
 * `--dry-run` prints the exact plan — key, content type, cache policy, byte size, order — and
 * uploads nothing. It needs no credentials, so it is also how an operator checks the prefix layout
 * before pointing this at a real bucket.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config as loadDotenv } from "dotenv";
import type { ExportManifest, ManifestArtifact } from "./export.js";

/**
 * The same `.env` load `src/config.ts` performs, done here because this script deliberately does
 * NOT import it: publish touches no database, so pulling in the server's configuration module
 * would make it announce a DATABASE_URL it never uses. A real environment variable still wins —
 * dotenv never overwrites what already reached the process — so an exported shell variable or a
 * task definition's injected value overrides the file rather than the other way round.
 */
loadDotenv({ quiet: true });

const OUT_DIR = "exports";

/**
 * Mirrors `scripts/export.ts`, deliberately duplicated rather than imported. That module's CLI
 * entry point is a top-level side effect (guarded only against Vitest), so importing a VALUE from
 * it would run a full export before this script uploaded anything. The `import type` above is
 * erased at compile time and is safe; these are not.
 */
const MANIFEST_NAME = "latest.manifest.json";
const LICENSE_NAME = "LICENSE";
const ALIAS_NAMES = { json: "latest.json", csv: "latest.csv" } as const;

/**
 * Cache policies, and the reason each key gets the one it gets.
 *
 * `immutable` is only honest for the archives, and only because the writer names them after a
 * digest of their own bytes: a key never designates two different datasets, so a year of caching
 * cannot serve content that has since been replaced. Do not hand it a key whose content can move.
 *
 * Everything under a stable key gets the short TTL instead — including, emphatically, the
 * manifest. A long TTL there would keep serving a previous run's `generatedAt` after a successful
 * publish, which fails a freshness check (the dataset is advertised as refreshed within 24h) on a
 * run that actually did everything right, and there is no invalidation step in this pipeline to
 * rescue it.
 */
export const CACHE_CONTROL = {
  /** A stable key, rewritten every run: revalidate often so today's dataset is served today. */
  mutable: "public, max-age=300",
  /** A content-addressed key: the bytes under it are fixed by the key itself. */
  immutable: "public, max-age=31536000, immutable",
} as const;

/** Content type by extension. `LICENSE` has none, and plain text is what it is. */
const CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  csv: "text/csv",
};

const contentTypeOf = (name: string): string =>
  CONTENT_TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "text/plain";

/** The subset of the S3 client this script uses — narrow enough for a test to stub. */
export interface S3Like {
  send(command: PutObjectCommand): Promise<unknown>;
  destroy?(): void;
}

export interface PublishConfig {
  bucket: string;
  /** `""` or `some/prefix/` — never a leading slash, always a trailing one when non-empty. */
  prefix: string;
  /** The region, when the environment names one. Undefined means the SDK's own default chain. */
  region?: string;
}

/** One object to upload: where its bytes are, what key they go under, and how they are served. */
export interface UploadEntry {
  /** The file's name inside the export directory — exactly what the writer wrote. */
  name: string;
  /** The object key: the prefix applied to `name`. */
  key: string;
  contentType: string;
  cacheControl: string;
  /**
   * The manifest's FULL sha256, for the two archives it records one for. Checked against the bytes
   * on disk before the first upload — publishing an archive that does not hash to what the
   * manifest promises would hand every consumer a verification failure.
   */
  sha256?: string;
}

/** An `UploadEntry` with what the filesystem says about it. */
export interface PlannedUpload extends UploadEntry {
  path: string;
  size: number;
}

export interface PublishResult {
  bucket: string;
  prefix: string;
  region?: string;
  /** The run this publication carries, straight out of the manifest. */
  runId: string;
  dryRun: boolean;
  /** Every object, in upload order. */
  uploads: PlannedUpload[];
}

export interface PublishOptions {
  /** Directory to publish. Defaults to `./exports`. */
  dir?: string;
  /** Configuration. Defaults to reading the environment. */
  config?: PublishConfig;
  /** Print the plan and upload nothing. Needs no credentials. */
  dryRun?: boolean;
  /** Injected client, so the tests can watch what would be sent without a network. */
  client?: S3Like;
}

/**
 * Thrown when the environment does not describe a destination. No default is guessed at: a bucket
 * name is not something this repo can hold, and a wrong one is a publication to the wrong place.
 */
export class PublishConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishConfigError";
  }
}

/**
 * Thrown when the directory is not something that can be published: no manifest, a manifest that
 * does not describe a run, a file it names that is not there, or an archive whose bytes do not
 * hash to what it records. Every one of these is established BEFORE the first upload, so nothing
 * has been sent when this is raised.
 */
export class PublishSourceError extends Error {
  constructor(
    readonly detail: string,
    override readonly cause?: unknown,
  ) {
    super(
      `${detail}. Publish only uploads what a completed export left behind — run \`pnpm export\` and try again.`,
    );
    this.name = "PublishSourceError";
  }
}

/**
 * Thrown when an upload fails part-way. Names what landed and what did not, because the interesting
 * fact about a half-finished publication is not the SDK's error — it is that the manifest was not
 * among the objects replaced, which is what leaves the bucket resolving to the previous run.
 */
export class PublishUploadError extends Error {
  constructor(
    readonly failed: string,
    readonly uploaded: readonly string[],
    override readonly cause: unknown,
  ) {
    super(
      [
        `failed to upload ${failed} after uploading`,
        uploaded.length > 0 ? uploaded.join(", ") : "nothing",
        `— ${MANIFEST_NAME} was NOT replaced, so the bucket still resolves to the previous run.`,
        "Re-run the publish to complete it.",
      ].join(" "),
    );
    this.name = "PublishUploadError";
  }
}

/**
 * Bucket names are DNS-compatible: 3–63 characters, lowercase alphanumerics, dots and hyphens,
 * starting and ending alphanumeric. Checked here so a typo fails immediately and locally rather
 * than as an opaque SDK error after the process has been handed credentials.
 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** `""` or `a/b/` — never a leading slash, always a trailing one, never a doubled separator. */
export function normalizePrefix(raw: string | undefined): string {
  const trimmed = (raw ?? "")
    .trim()
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

/** Read the destination from the environment. Every value is validated; none has a default. */
export function readPublishConfig(env: NodeJS.ProcessEnv = process.env): PublishConfig {
  const bucket = (env.S3_BUCKET ?? "").trim();
  if (!bucket) {
    throw new PublishConfigError(
      "S3_BUCKET is required: this uploads to exactly one bucket and has no default to guess at. Export it in the environment (or set it in packages/api/.env — a real environment variable wins) and re-run.",
    );
  }
  if (bucket.includes("/") || bucket.includes(":")) {
    throw new PublishConfigError(
      `S3_BUCKET is the bucket NAME, not a URI and not a path — a key prefix belongs in S3_PREFIX. Got ${JSON.stringify(bucket)}.`,
    );
  }
  if (!BUCKET_NAME.test(bucket)) {
    throw new PublishConfigError(
      `S3_BUCKET ${JSON.stringify(bucket)} is not a valid bucket name: 3–63 characters, lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit.`,
    );
  }
  return {
    bucket,
    prefix: normalizePrefix(env.S3_PREFIX),
    // The SDK reads AWS_REGION itself. It is read here as well so the printed plan can name the
    // region the upload will actually use, rather than leaving it to be inferred.
    region: (env.AWS_REGION ?? "").trim() || undefined,
  };
}

/** The manifest's entry for one format, validated to the extent the publish step depends on it. */
function artifactFor(manifest: ExportManifest, format: "json" | "csv"): ManifestArtifact {
  const matches = (manifest.artifacts ?? []).filter((a) => a?.format === format);
  const artifact = matches[0];
  if (matches.length !== 1 || !artifact) {
    throw new PublishSourceError(
      `${MANIFEST_NAME} names ${matches.length} ${format} artifacts, and a run publishes exactly one`,
    );
  }
  if (typeof artifact.href !== "string" || !artifact.href) {
    throw new PublishSourceError(`${MANIFEST_NAME}'s ${format} artifact has no href`);
  }
  // The href becomes both a path to read and a key to write, so it has to be a plain file name.
  // A manifest is machine-written, but "the pointer decides which bytes leave this machine" is not
  // a sentence to leave unguarded.
  if (/[\\/]/.test(artifact.href) || artifact.href === "." || artifact.href === "..") {
    throw new PublishSourceError(
      `${MANIFEST_NAME}'s ${format} href ${JSON.stringify(artifact.href)} is not a plain file name`,
    );
  }
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    throw new PublishSourceError(
      `${MANIFEST_NAME}'s ${format} artifact records no sha256, so nothing could be verified before upload`,
    );
  }
  return artifact;
}

/** Parse and validate a manifest document. Everything the plan reads off it is checked here. */
export function parseManifest(text: string): ExportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PublishSourceError(`${MANIFEST_NAME} is not valid JSON`, err);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as ExportManifest).artifacts)
  ) {
    throw new PublishSourceError(`${MANIFEST_NAME} does not describe an export run`);
  }
  const manifest = parsed as ExportManifest;
  if (typeof manifest.runId !== "string" || !manifest.runId) {
    throw new PublishSourceError(`${MANIFEST_NAME} carries no runId`);
  }
  // Validated for their side effects: a malformed artifact must fail here, before any upload.
  artifactFor(manifest, "json");
  artifactFor(manifest, "csv");
  return manifest;
}

/**
 * The upload plan: the six objects, in the order they go up.
 *
 * The order is the writer's, and it is load-bearing rather than cosmetic — see the header. The
 * archive names are the manifest's `href`s, never re-derived.
 */
export function buildUploadPlan(manifest: ExportManifest, prefix = ""): UploadEntry[] {
  const json = artifactFor(manifest, "json");
  const csv = artifactFor(manifest, "csv");
  const entry = (name: string, cacheControl: string, sha256?: string): UploadEntry => ({
    name,
    key: `${prefix}${name}`,
    contentType: contentTypeOf(name),
    cacheControl,
    ...(sha256 ? { sha256 } : {}),
  });

  return [
    entry(LICENSE_NAME, CACHE_CONTROL.mutable),
    entry(json.href, CACHE_CONTROL.immutable, json.sha256),
    entry(csv.href, CACHE_CONTROL.immutable, csv.sha256),
    entry(ALIAS_NAMES.json, CACHE_CONTROL.mutable),
    entry(ALIAS_NAMES.csv, CACHE_CONTROL.mutable),
    entry(MANIFEST_NAME, CACHE_CONTROL.mutable),
  ];
}

/** A directory's manifest and the plan derived from it. */
export interface PublicationPlan {
  manifest: ExportManifest;
  uploads: PlannedUpload[];
}

/**
 * Turn a directory into a plan: read its manifest, name the six objects, and establish that every
 * one of them is on disk and — where the manifest says so — hashes to what it recorded. All of it
 * happens before the first upload, so an incomplete or inconsistent directory costs nothing but a
 * non-zero exit.
 */
export async function planPublication(dir: string, prefix = ""): Promise<PublicationPlan> {
  const manifestPath = join(dir, MANIFEST_NAME);
  const text = await readFile(manifestPath, "utf8").catch((err: NodeJS.ErrnoException) => {
    throw new PublishSourceError(
      err.code === "ENOENT"
        ? `${manifestPath} does not exist`
        : `${manifestPath} could not be read`,
      err,
    );
  });

  const manifest = parseManifest(text);
  const plan = buildUploadPlan(manifest, prefix);
  const uploads: PlannedUpload[] = [];
  for (const entry of plan) {
    const path = join(dir, entry.name);
    const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
      throw new PublishSourceError(
        err.code === "ENOENT"
          ? `${path} is named by ${MANIFEST_NAME} but is not in ${dir}`
          : `${path} could not be read`,
        err,
      );
    });
    uploads.push({ ...entry, path, size: info.size });
  }

  for (const upload of uploads) {
    if (!upload.sha256) continue;
    const digest = createHash("sha256")
      .update(await readFile(upload.path))
      .digest("hex");
    if (digest !== upload.sha256) {
      throw new PublishSourceError(
        `${upload.path} hashes to ${digest}, but ${MANIFEST_NAME} records ${upload.sha256} — publishing it would hand every consumer a verification failure`,
      );
    }
  }

  return { manifest, uploads };
}

/** Render a plan for a human: what goes where, in what order, and how it will be served. */
export function formatPlan(result: PublishResult): string {
  const { uploads, dryRun } = result;
  const width = (pick: (u: PlannedUpload) => string): number =>
    Math.max(...uploads.map((u) => pick(u).length));
  const keyWidth = Math.max(
    width((u) => u.key),
    3,
  );
  const typeWidth = Math.max(
    width((u) => u.contentType),
    "content-type".length,
  );
  const cacheWidth = Math.max(
    width((u) => u.cacheControl),
    "cache-control".length,
  );
  const sizeWidth = Math.max(
    width((u) => String(u.size)),
    "bytes".length,
  );

  const row = (n: string, key: string, type: string, cache: string, size: string): string =>
    `  ${n.padStart(2)}  ${key.padEnd(keyWidth)}  ${type.padEnd(typeWidth)}  ${cache.padEnd(cacheWidth)}  ${size.padStart(sizeWidth)}`;

  const total = uploads.reduce((sum, u) => sum + u.size, 0);
  const destination = `s3://${result.bucket}/${result.prefix}`;
  const region = result.region ?? "region from the SDK's default chain";
  const lines = [
    dryRun
      ? `publish plan for ${destination} (${region}) — run ${result.runId}`
      : `✓ published run ${result.runId} to ${destination} (${region})`,
    "",
    row("#", "key", "content-type", "cache-control", "bytes"),
    ...uploads.map((u, i) =>
      row(String(i + 1), u.key, u.contentType, u.cacheControl, String(u.size)),
    ),
    "",
    `  total: ${uploads.length} objects, ${total} bytes`,
  ];
  if (dryRun) {
    lines.push(
      `  DRY RUN — nothing was uploaded. That order is the upload order: ${MANIFEST_NAME} goes`,
      "  last, so until it lands the bucket still resolves to the previous run.",
    );
  }
  return lines.join("\n");
}

/** Publish a completed export. Sequential and fail-fast; the manifest goes last. */
export async function runPublish(options: PublishOptions = {}): Promise<PublishResult> {
  const dir = options.dir ?? OUT_DIR;
  const config = options.config ?? readPublishConfig();
  const { manifest, uploads } = await planPublication(dir, config.prefix);
  const result: PublishResult = {
    ...config,
    runId: manifest.runId,
    dryRun: options.dryRun === true,
    uploads,
  };
  if (result.dryRun) return result;

  // Only a client this function created is a client this function may destroy.
  const injected = options.client;
  const client = injected ?? new S3Client({ ...(config.region ? { region: config.region } : {}) });
  const uploaded: string[] = [];
  try {
    for (const upload of uploads) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: upload.key,
            Body: await readFile(upload.path),
            ContentType: upload.contentType,
            CacheControl: upload.cacheControl,
            // No ACL, deliberately. Public read is granted by the bucket's own policy; this
            // identity holds s3:PutObject and nothing else, and a bucket with ownership enforced
            // rejects an ACL-bearing request outright.
          }),
        );
      } catch (err) {
        throw new PublishUploadError(upload.name, uploaded, err);
      }
      uploaded.push(upload.name);
    }
  } finally {
    if (!injected) client.destroy?.();
  }
  return result;
}

// CLI entry — skipped under Vitest so tests can import the parts without side effects.
if (!process.env.VITEST) {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  runPublish({ dryRun })
    .then((result) => {
      console.log(formatPlan(result));
    })
    .catch((err) => {
      const expected =
        err instanceof PublishConfigError ||
        err instanceof PublishSourceError ||
        err instanceof PublishUploadError;
      console.error(expected ? `✗ ${err.message}` : err);
      process.exitCode = 1;
    });
}
