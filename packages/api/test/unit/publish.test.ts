/**
 * PURE publish tests: what the publish step decides before it is allowed near a network.
 *
 * The upload itself is one `PutObjectCommand` per file, so the interesting behaviour is entirely in
 * the decisions around it — which keys, in which ORDER, with which content type and cache policy,
 * and which directories it refuses to publish at all. All of that is exercised here against a
 * fixture directory and a stub client: no bucket, no credentials, no network.
 *
 * The ordering assertions are the load-bearing ones. A bucket cannot replace two keys together, so
 * `latest.manifest.json` going last is the only thing that keeps a half-finished publication
 * resolving to the previous run.
 */
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PutObjectCommand, PutObjectCommandInput } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import type { ExportManifest, ManifestArtifact } from "../../scripts/export.js";
import {
  CACHE_CONTROL,
  PublishConfigError,
  PublishSourceError,
  PublishUploadError,
  type S3Like,
  buildUploadPlan,
  formatPlan,
  normalizePrefix,
  parseManifest,
  planPublication,
  readPublishConfig,
  runPublish,
} from "../../scripts/publish.js";

const ROOT = join(tmpdir(), "rfphub-publish-test");
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const JSON_ARCHIVE = "opportunities-2026-08-13-0123456789ab.json";
const CSV_ARCHIVE = "opportunities-2026-08-13-ba9876543210.csv";
const JSON_BODY = '{"count":1}\n';
const CSV_BODY = "id\nx\n";

/** The manifest's entry for one archive, as the exporter records it. */
const jsonArtifact = (overrides: Partial<ManifestArtifact> = {}): ManifestArtifact => ({
  format: "json",
  href: JSON_ARCHIVE,
  sha256: sha256(JSON_BODY),
  count: 1,
  ...overrides,
});

const csvArtifact = (overrides: Partial<ManifestArtifact> = {}): ManifestArtifact => ({
  format: "csv",
  href: CSV_ARCHIVE,
  sha256: sha256(CSV_BODY),
  count: 1,
  ...overrides,
});

/** A manifest of the shape `scripts/export.ts` promotes, with the digests of the bodies below. */
const manifest = (overrides: Partial<ExportManifest> = {}): ExportManifest => ({
  specVersion: "1.0.0",
  license: "CC0-1.0",
  runId: "0".repeat(32),
  generatedAt: "2026-08-13T09:00:00.000Z",
  count: 1,
  artifacts: [jsonArtifact(), csvArtifact()],
  ...overrides,
});

/** A complete export directory: the six files a finished run leaves behind. */
async function writeExport(dir: string, doc: ExportManifest = manifest()): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "LICENSE"), "SPDX-License-Identifier: CC0-1.0\n");
  await writeFile(join(dir, JSON_ARCHIVE), JSON_BODY);
  await writeFile(join(dir, CSV_ARCHIVE), CSV_BODY);
  await writeFile(join(dir, "latest.json"), JSON_BODY);
  await writeFile(join(dir, "latest.csv"), CSV_BODY);
  await writeFile(join(dir, "latest.manifest.json"), `${JSON.stringify(doc, null, 2)}\n`);
  return dir;
}

/**
 * A stub client that records what it was asked to send. `failOn` makes the matching key throw, so
 * a test can watch what a mid-flight failure leaves behind — the command is recorded before it
 * fails, because "attempted" and "landed" are different facts and the test asserts about both.
 */
function recorder(failOn?: string): { sent: PutObjectCommandInput[]; client: S3Like } {
  const sent: PutObjectCommandInput[] = [];
  return {
    sent,
    client: {
      async send(command: PutObjectCommand): Promise<unknown> {
        sent.push(command.input);
        if (failOn && command.input.Key === failOn) throw new Error("upstream refused the object");
        return {};
      },
    },
  };
}

const config = { bucket: "example-bucket", prefix: "" };

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("normalizePrefix", () => {
  it("is empty when nothing is configured", () => {
    for (const raw of [undefined, "", "   ", "/", "///"]) {
      expect(normalizePrefix(raw), JSON.stringify(raw)).toBe("");
    }
  });

  // A key prefix is not a path: a leading slash produces an object whose key begins with `/`, which
  // is legal in S3 and wrong everywhere else, and a doubled separator makes an empty path segment.
  it("normalizes to `a/b/` — no leading slash, one trailing, no doubles", () => {
    for (const raw of ["data", "/data", "data/", "/data/", " data ", "//data//"]) {
      expect(normalizePrefix(raw), JSON.stringify(raw)).toBe("data/");
    }
    expect(normalizePrefix("open-data/v1")).toBe("open-data/v1/");
    expect(normalizePrefix("/open-data//v1/")).toBe("open-data/v1/");
  });
});

describe("readPublishConfig", () => {
  // No default: a bucket name is not something this repo can carry, and guessing one is a
  // publication to the wrong place.
  it("requires S3_BUCKET, and says how to supply it", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(() => readPublishConfig({ S3_BUCKET: raw }), JSON.stringify(raw)).toThrow(
        PublishConfigError,
      );
    }
    expect(() => readPublishConfig({})).toThrow(/S3_BUCKET is required/);
  });

  // The common paste. A URI or a path in S3_BUCKET is not a bucket that exists under that name.
  it("rejects a URI or a path where a bucket name belongs", () => {
    for (const raw of ["s3://example-bucket", "example-bucket/data", "https://example.org"]) {
      expect(() => readPublishConfig({ S3_BUCKET: raw }), raw).toThrow(/bucket NAME/);
    }
  });

  it("rejects a name no bucket could have", () => {
    for (const raw of [
      "ab",
      "Example-Bucket",
      "-example",
      "example-",
      "exam ple",
      "a".repeat(64),
    ]) {
      expect(() => readPublishConfig({ S3_BUCKET: raw }), raw).toThrow(/not a valid bucket name/);
    }
  });

  it("reads the bucket, the normalized prefix and the region", () => {
    expect(readPublishConfig({ S3_BUCKET: " example-bucket " })).toEqual({
      bucket: "example-bucket",
      prefix: "",
      region: undefined,
    });
    expect(
      readPublishConfig({ S3_BUCKET: "example-bucket", S3_PREFIX: "/open-data/", AWS_REGION: "x" }),
    ).toEqual({ bucket: "example-bucket", prefix: "open-data/", region: "x" });
  });

  // Unset means the SDK's own chain — a config file, an instance role — not a guess made here.
  it("leaves the region undefined when the environment does not name one", () => {
    expect(readPublishConfig({ S3_BUCKET: "example-bucket", AWS_REGION: "  " }).region).toBe(
      undefined,
    );
  });
});

describe("parseManifest", () => {
  it("accepts what the exporter promotes", () => {
    expect(parseManifest(JSON.stringify(manifest())).runId).toBe("0".repeat(32));
  });

  it("refuses a document that does not describe a run", () => {
    expect(() => parseManifest("{oops")).toThrow(/is not valid JSON/);
    expect(() => parseManifest("[]")).toThrow(/does not describe an export run/);
    expect(() => parseManifest("{}")).toThrow(/does not describe an export run/);
    expect(() => parseManifest(JSON.stringify(manifest({ runId: "" })))).toThrow(/no runId/);
  });

  it("requires exactly one archive per format", () => {
    const doubled = manifest({ artifacts: [jsonArtifact(), jsonArtifact(), csvArtifact()] });
    expect(() => parseManifest(JSON.stringify(doubled))).toThrow(/names 2 json artifacts/);
    expect(() => parseManifest(JSON.stringify(manifest({ artifacts: [] })))).toThrow(
      /names 0 json artifacts/,
    );
  });

  // The href is used twice — as a path to read and as a key to write — so a manifest cannot be
  // allowed to name anything but a file sitting in the directory it was found in.
  it("requires each href to be a plain file name", () => {
    for (const href of ["../secret.json", "nested/a.json", ".", ".."]) {
      const doc = manifest({ artifacts: [jsonArtifact({ href }), csvArtifact()] });
      expect(() => parseManifest(JSON.stringify(doc)), href).toThrow(/not a plain file name/);
    }
  });

  it("requires a full sha256 per archive, because that is what gets verified", () => {
    // the 12-hex prefix the NAME carries is an addressing scheme, not the checksum a consumer
    // verifies against — the manifest has to carry all 256 bits
    const doc = manifest({ artifacts: [jsonArtifact({ sha256: "0123456789ab" }), csvArtifact()] });
    expect(() => parseManifest(JSON.stringify(doc))).toThrow(/records no sha256/);
  });
});

describe("buildUploadPlan", () => {
  // THE order assertion. It mirrors the writer's, and it is what makes a failed publication safe:
  // the sidecar precedes the data, the immutable archives precede everything that points at them,
  // and the single authoritative pointer goes last.
  it("plans the writer's order, manifest last", () => {
    expect(buildUploadPlan(manifest()).map((u) => u.name)).toEqual([
      "LICENSE",
      JSON_ARCHIVE,
      CSV_ARCHIVE,
      "latest.json",
      "latest.csv",
      "latest.manifest.json",
    ]);
  });

  // The archive names come out of the MANIFEST, never re-derived from a date and a digest — a
  // publish step with its own copy of the naming rule is a publish step that can disagree with the
  // pointer it is uploading.
  it("takes the archive names from the manifest it was given", () => {
    const href = "opportunities-1999-01-01-aaaaaaaaaaaa.json";
    const doc = manifest({ artifacts: [jsonArtifact({ href }), csvArtifact()] });
    expect(buildUploadPlan(doc)[1]?.name).toBe(href);
  });

  it("serves each object as what it is", () => {
    const byName = Object.fromEntries(buildUploadPlan(manifest()).map((u) => [u.name, u]));
    expect(byName.LICENSE?.contentType).toBe("text/plain");
    expect(byName[JSON_ARCHIVE]?.contentType).toBe("application/json");
    expect(byName[CSV_ARCHIVE]?.contentType).toBe("text/csv");
    expect(byName["latest.json"]?.contentType).toBe("application/json");
    expect(byName["latest.csv"]?.contentType).toBe("text/csv");
    expect(byName["latest.manifest.json"]?.contentType).toBe("application/json");
  });

  /**
   * `immutable` is only honest for the digest-named archives, whose key is derived from their own
   * bytes. Everything under a stable key gets the short TTL — the manifest emphatically included:
   * a year of caching there would keep serving a previous run's `generatedAt` after a publication
   * that did everything right, and there is no invalidation step to rescue it.
   */
  it("promises immutability only for the content-addressed keys", () => {
    const byName = Object.fromEntries(buildUploadPlan(manifest()).map((u) => [u.name, u]));
    expect(byName[JSON_ARCHIVE]?.cacheControl).toBe(CACHE_CONTROL.immutable);
    expect(byName[CSV_ARCHIVE]?.cacheControl).toBe(CACHE_CONTROL.immutable);
    for (const name of ["LICENSE", "latest.json", "latest.csv", "latest.manifest.json"]) {
      expect(byName[name]?.cacheControl, name).toBe(CACHE_CONTROL.mutable);
    }
    expect(CACHE_CONTROL.immutable).toBe("public, max-age=31536000, immutable");
    expect(CACHE_CONTROL.mutable).toBe("public, max-age=300");
  });

  it("applies the prefix to every key and to nothing else", () => {
    const plan = buildUploadPlan(manifest(), "open-data/");
    expect(plan.map((u) => u.key)).toEqual([
      "open-data/LICENSE",
      `open-data/${JSON_ARCHIVE}`,
      `open-data/${CSV_ARCHIVE}`,
      "open-data/latest.json",
      "open-data/latest.csv",
      "open-data/latest.manifest.json",
    ]);
    // the name stays the FILE's name: the prefix is a bucket layout, not a rename
    expect(plan.map((u) => u.name)).toEqual(buildUploadPlan(manifest()).map((u) => u.name));
  });
});

describe("planPublication", () => {
  it("reports every file's size, in upload order", async () => {
    const dir = await writeExport(join(ROOT, "plan"));
    const { manifest: doc, uploads } = await planPublication(dir, "open-data/");
    expect(doc.runId).toBe("0".repeat(32));
    expect(uploads.map((u) => u.name).at(-1)).toBe("latest.manifest.json");
    expect(uploads.every((u) => u.size > 0)).toBe(true);
    expect(uploads[1]?.size).toBe(Buffer.byteLength(JSON_BODY));
    expect(uploads[1]?.path).toBe(join(dir, JSON_ARCHIVE));
  });

  it("refuses a directory with no manifest", async () => {
    const dir = join(ROOT, "empty");
    await mkdir(dir, { recursive: true });
    await expect(planPublication(dir)).rejects.toThrow(PublishSourceError);
    await expect(planPublication(dir)).rejects.toThrow(/does not exist/);
  });

  // A manifest that outlived its data. Establishing this BEFORE the first upload is the point:
  // the alternative is discovering it with three objects already replaced.
  it("refuses when a file the manifest names is missing", async () => {
    const dir = await writeExport(join(ROOT, "incomplete"));
    await rm(join(dir, CSV_ARCHIVE));
    await expect(planPublication(dir)).rejects.toThrow(
      new RegExp(`${CSV_ARCHIVE} is named by latest.manifest.json but is not in`),
    );
  });

  // Publishing bytes that do not hash to what the manifest promises hands every consumer following
  // the documented contract a verification failure — from a publish run that reported success.
  it("refuses when an archive does not hash to what the manifest records", async () => {
    const dir = await writeExport(join(ROOT, "tampered"));
    await writeFile(join(dir, CSV_ARCHIVE), "id\ntampered\n");
    await expect(planPublication(dir)).rejects.toThrow(/hashes to [0-9a-f]{64}, but/);
  });
});

describe("runPublish", () => {
  it("uploads every object once, in the planned order, and nothing else", async () => {
    const dir = await writeExport(join(ROOT, "upload"));
    const { sent, client } = recorder();
    const result = await runPublish({ dir, config: { ...config, prefix: "open-data/" }, client });

    expect(sent.map((s) => s.Key)).toEqual([
      "open-data/LICENSE",
      `open-data/${JSON_ARCHIVE}`,
      `open-data/${CSV_ARCHIVE}`,
      "open-data/latest.json",
      "open-data/latest.csv",
      "open-data/latest.manifest.json",
    ]);
    expect(sent.every((s) => s.Bucket === "example-bucket")).toBe(true);
    expect(sent.map((s) => s.ContentType)).toEqual([
      "text/plain",
      "application/json",
      "text/csv",
      "application/json",
      "text/csv",
      "application/json",
    ]);
    expect(sent.at(-1)?.CacheControl).toBe(CACHE_CONTROL.mutable);
    expect(sent[1]?.CacheControl).toBe(CACHE_CONTROL.immutable);
    // the bytes that went up are the bytes on disk
    expect(sent[1]?.Body?.toString()).toBe(JSON_BODY);
    expect(result.dryRun).toBe(false);
    expect(result.runId).toBe("0".repeat(32));
  });

  /**
   * Public read is a property of the BUCKET POLICY, granted where the bucket is created. This
   * identity holds `s3:PutObject` and nothing else, and a bucket with ownership enforced rejects an
   * ACL-bearing request outright — so an ACL here would not be a harmless belt-and-braces, it would
   * fail every upload.
   */
  it("sets no ACL on anything", async () => {
    const dir = await writeExport(join(ROOT, "no-acl"));
    const { sent, client } = recorder();
    await runPublish({ dir, config, client });
    for (const input of sent) {
      expect("ACL" in input, input.Key).toBe(false);
      expect("GrantRead" in input, input.Key).toBe(false);
    }
  });

  /**
   * THE failure invariant. A bucket has no way to replace two keys together, so the order is the
   * whole guarantee: whatever goes wrong, the manifest is not among the objects replaced, and a
   * consumer resolving the pointer still gets the previous run, whole.
   */
  it("stops at the first failure and never replaces the manifest", async () => {
    const dir = await writeExport(join(ROOT, "failure"));
    const { sent, client } = recorder(CSV_ARCHIVE);

    await expect(runPublish({ dir, config, client })).rejects.toThrow(PublishUploadError);
    await expect(runPublish({ dir, config, client })).rejects.toThrow(
      new RegExp(
        `failed to upload ${CSV_ARCHIVE} after uploading LICENSE, ${JSON_ARCHIVE} — latest\\.manifest\\.json was NOT replaced`,
      ),
    );

    // nothing after the failing object was even attempted — both aliases and the pointer are
    // untouched, so the bucket is exactly the previous run plus two immutable objects nothing
    // points at yet
    expect(sent.map((s) => s.Key)).toEqual([
      "LICENSE",
      JSON_ARCHIVE,
      CSV_ARCHIVE,
      "LICENSE",
      JSON_ARCHIVE,
      CSV_ARCHIVE,
    ]);
    expect(sent.some((s) => s.Key === "latest.manifest.json")).toBe(false);
    expect(sent.some((s) => s.Key === "latest.json")).toBe(false);
  });

  it("carries the underlying failure rather than swallowing it", async () => {
    const dir = await writeExport(join(ROOT, "cause"));
    const { client } = recorder("LICENSE");
    const err = await runPublish({ dir, config, client }).catch((e) => e);
    expect(err).toBeInstanceOf(PublishUploadError);
    expect((err as PublishUploadError).uploaded).toEqual([]);
    expect((err as Error).cause).toMatchObject({ message: "upstream refused the object" });
  });

  // The dry run is what an operator checks a prefix layout with, so it must not need a client at
  // all — not merely not use one.
  it("uploads nothing on a dry run, and needs no client to produce the plan", async () => {
    const dir = await writeExport(join(ROOT, "dry"));
    const { sent, client } = recorder();
    const withClient = await runPublish({ dir, config, client, dryRun: true });
    expect(sent).toEqual([]);

    const result = await runPublish({
      dir,
      config: { ...config, prefix: "open-data/" },
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.uploads.map((u) => u.key)).toEqual(
      withClient.uploads.map((u) => `open-data/${u.name}`),
    );

    // and it still refuses to plan a directory it could not publish
    await rm(join(dir, "latest.csv"));
    await expect(runPublish({ dir, config, dryRun: true })).rejects.toThrow(PublishSourceError);
  });

  it("reads its destination from the environment when none is passed", async () => {
    const dir = await writeExport(join(ROOT, "env"));
    const restore = { ...process.env };
    process.env.S3_BUCKET = "example-bucket";
    process.env.S3_PREFIX = "/open-data/";
    try {
      const result = await runPublish({ dir, dryRun: true });
      expect(result.bucket).toBe("example-bucket");
      expect(result.uploads[0]?.key).toBe("open-data/LICENSE");
    } finally {
      process.env = restore;
    }
  });
});

describe("formatPlan", () => {
  it("prints every column of the plan, in order, and says nothing was uploaded", async () => {
    const dir = await writeExport(join(ROOT, "format"));
    const printed = formatPlan(await runPublish({ dir, config, dryRun: true }));

    expect(printed).toContain("publish plan for s3://example-bucket/");
    expect(printed).toContain("region from the SDK's default chain");
    expect(printed).toContain("DRY RUN — nothing was uploaded");
    expect(printed).toContain("total: 6 objects");
    // the rows are in upload order, ending on the pointer
    const keyLines = printed.split("\n").filter((l) => /^\s+\d+\s/.test(l));
    expect(keyLines).toHaveLength(6);
    expect(keyLines[0]).toMatch(/LICENSE\s+text\/plain\s+public, max-age=300\s+\d+$/);
    expect(keyLines[1]).toMatch(
      new RegExp(`${JSON_ARCHIVE}\\s+application/json\\s+public, max-age=31536000, immutable`),
    );
    expect(keyLines.at(-1)).toContain("latest.manifest.json");
  });

  it("names the run and the region on a real publication", async () => {
    const dir = await writeExport(join(ROOT, "format-real"));
    const { client } = recorder();
    const printed = formatPlan(
      await runPublish({ dir, config: { ...config, region: "eu-west-1" }, client }),
    );
    expect(printed).toContain(`✓ published run ${"0".repeat(32)} to s3://example-bucket/`);
    expect(printed).toContain("(eu-west-1)");
    expect(printed).not.toContain("DRY RUN");
  });
});
