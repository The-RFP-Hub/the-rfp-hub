/**
 * Publication sinks for the open-data export.
 *
 * The exporter does not know where the dataset lands — it hands each artifact to an `ExportSink`
 * and records whatever URL the sink reports back in `dataset_snapshots.url`. Two sinks ship:
 *
 *   local  — writes under a directory (default `exports/`). No credentials, no network, so
 *            `pnpm export` works offline. This stays the default when S3_BUCKET is unset.
 *   s3     — uploads to an S3 bucket (or any S3-compatible store via S3_ENDPOINT). Selected
 *            purely by the presence of S3_BUCKET; credentials/region come from the standard
 *            AWS_* environment variables the SDK already reads.
 *
 * Everything deployment-specific is env-var-only — nothing about a bucket, endpoint or CDN host
 * is ever committed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Cache policies the exporter picks from. `S3_PUBLIC_BASE_URL` exists to put a CDN in front of the
 * bucket, and without an explicit header every object inherits the CDN's origin default: the
 * moving `latest.*` aliases would be served stale for that TTL after each nightly run (there is no
 * invalidation step), while the dated archives — content-addressed by date and never rewritten —
 * would be revalidated against the origin for no reason.
 */
export const CACHE_CONTROL = {
  /** Rewritten every run: revalidate often so a consumer sees tonight's dataset tonight. */
  mutable: "public, max-age=300",
  /** Written once under a dated key and never changed. */
  immutable: "public, max-age=31536000, immutable",
} as const;

/** Where an export artifact is published. Returns the URL to record for that artifact. */
export interface ExportSink {
  /** One-line description of the destination, for the CLI log. */
  readonly description: string;
  /** `cacheControl` is advisory: object stores carry it, the local directory sink ignores it. */
  put(key: string, body: string, contentType: string, cacheControl?: string): Promise<string>;
}

/** The subset of the S3 client the sink uses — narrow enough for tests to stub. */
export interface S3Like {
  send(command: PutObjectCommand): Promise<unknown>;
}

export interface S3SinkConfig {
  bucket: string;
  /** Key prefix, already normalized to `""` or `some/prefix/`. */
  prefix: string;
  /** Public/CDN base the objects are served from; empty ⇒ record `s3://` URIs instead. */
  publicBaseUrl: string;
  region?: string;
  /** Custom endpoint for S3-compatible stores (implies path-style addressing). */
  endpoint?: string;
}

const trimSlashes = (s: string): string => s.replace(/^\/+|\/+$/g, "");

/** `""` or `a/b/` — never a leading slash, always a trailing one when non-empty. */
function normalizePrefix(raw: string | undefined): string {
  const trimmed = trimSlashes((raw ?? "").trim());
  return trimmed ? `${trimmed}/` : "";
}

/**
 * Read the S3 sink's configuration off the environment. Returns `null` when S3_BUCKET is unset,
 * which is what selects the local sink.
 */
export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3SinkConfig | null {
  const bucket = (env.S3_BUCKET ?? "").trim();
  if (!bucket) return null;
  return {
    bucket,
    prefix: normalizePrefix(env.S3_PREFIX),
    publicBaseUrl: (env.S3_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    region: (env.AWS_REGION ?? "").trim() || undefined,
    endpoint: (env.S3_ENDPOINT ?? "").trim() || undefined,
  };
}

/**
 * Upload artifacts to S3. `client` is injectable so the tests exercise the key layout, content
 * types and recorded URLs without a network or credentials.
 */
export function createS3Sink(cfg: S3SinkConfig, client?: S3Like): ExportSink {
  const s3 =
    client ??
    new S3Client({
      ...(cfg.region ? { region: cfg.region } : {}),
      // A custom endpoint means an S3-compatible store, which generally needs path-style keys.
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
    });

  return {
    description: `s3://${cfg.bucket}/${cfg.prefix}`,
    async put(key, body, contentType, cacheControl) {
      const objectKey = `${cfg.prefix}${key}`;
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: objectKey,
          Body: body,
          ContentType: contentType,
          ...(cacheControl ? { CacheControl: cacheControl } : {}),
        }),
      );
      return cfg.publicBaseUrl
        ? `${cfg.publicBaseUrl}/${objectKey}`
        : `s3://${cfg.bucket}/${objectKey}`;
    },
  };
}

/**
 * Write artifacts to a local directory; the recorded URL is the path that was written.
 * `contentType`/`cacheControl` are HTTP concerns a filesystem cannot carry, so both are ignored.
 */
export function createLocalSink(outDir: string): ExportSink {
  return {
    description: outDir,
    async put(key, body) {
      const path = join(outDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      return path;
    },
  };
}

/**
 * Pick the sink from the environment: S3 when S3_BUCKET is set, the local directory otherwise.
 */
export function createSinkFromEnv(
  outDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ExportSink {
  const s3 = readS3Config(env);
  return s3 ? createS3Sink(s3) : createLocalSink(outDir);
}
