/** PURE sink tests — env parsing, key layout and recorded URLs. No DB, no network. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import {
  CACHE_CONTROL,
  type S3Like,
  createLocalSink,
  createS3Sink,
  createSinkFromEnv,
  readS3Config,
} from "../../scripts/upload.js";

function stubS3(): { client: S3Like; inputs: PutObjectCommand["input"][] } {
  const inputs: PutObjectCommand["input"][] = [];
  return {
    inputs,
    client: {
      async send(command: PutObjectCommand) {
        inputs.push(command.input);
        return {};
      },
    },
  };
}

const dirs: string[] = [];
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "rfphub-sink-"));
  dirs.push(dir);
  return dir;
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("readS3Config", () => {
  it("returns null without S3_BUCKET, so the local sink stays the default", () => {
    expect(readS3Config({})).toBeNull();
    expect(readS3Config({ S3_BUCKET: "   ", S3_REGION: "us-east-1" })).toBeNull();
  });

  it("normalizes the prefix and trims the public base URL", () => {
    expect(readS3Config({ S3_BUCKET: "b", S3_PREFIX: "/data/v1/" })?.prefix).toBe("data/v1/");
    expect(readS3Config({ S3_BUCKET: "b" })?.prefix).toBe("");
    expect(
      readS3Config({ S3_BUCKET: "b", S3_PUBLIC_BASE_URL: "https://data.example//" })?.publicBaseUrl,
    ).toBe("https://data.example");
  });

  it("carries the optional region and S3-compatible endpoint through", () => {
    const cfg = readS3Config({
      S3_BUCKET: "b",
      AWS_REGION: "eu-west-1",
      S3_ENDPOINT: "https://store.example",
    });
    expect(cfg).toMatchObject({ region: "eu-west-1", endpoint: "https://store.example" });
  });
});

describe("createS3Sink", () => {
  it("prefixes the key, sets the content type and records the public URL", async () => {
    const { client, inputs } = stubS3();
    const sink = createS3Sink(
      { bucket: "bucket", prefix: "data/", publicBaseUrl: "https://data.example" },
      client,
    );
    const url = await sink.put("latest.csv", "a,b\n", "text/csv; charset=utf-8");

    expect(url).toBe("https://data.example/data/latest.csv");
    expect(inputs).toEqual([
      {
        Bucket: "bucket",
        Key: "data/latest.csv",
        Body: "a,b\n",
        ContentType: "text/csv; charset=utf-8",
      },
    ]);
  });

  // S3_PUBLIC_BASE_URL exists to put a CDN in front of the bucket. Without an explicit header the
  // CDN applies its own origin default to the MOVING latest.* aliases and keeps serving yesterday's
  // dataset after the nightly run, with no invalidation step anywhere.
  it("carries the caller's cache policy through, and omits the header when there is none", async () => {
    const { client, inputs } = stubS3();
    const sink = createS3Sink({ bucket: "bucket", prefix: "", publicBaseUrl: "" }, client);

    await sink.put("latest.json", "{}", "application/json", CACHE_CONTROL.mutable);
    await sink.put(
      "opportunities-2026-01-01.json",
      "{}",
      "application/json",
      CACHE_CONTROL.immutable,
    );
    await sink.put("nocache.json", "{}", "application/json");

    expect(inputs.map((i) => i.CacheControl)).toEqual([
      "public, max-age=300",
      "public, max-age=31536000, immutable",
      undefined,
    ]);
  });

  it("falls back to an s3:// URI when no public base is configured", async () => {
    const { client } = stubS3();
    const sink = createS3Sink({ bucket: "bucket", prefix: "", publicBaseUrl: "" }, client);
    expect(await sink.put("latest.json", "{}", "application/json")).toBe("s3://bucket/latest.json");
  });
});

describe("createLocalSink", () => {
  it("writes the file and records the path it wrote", async () => {
    const dir = await scratch();
    const sink = createLocalSink(dir);
    const path = await sink.put("latest.csv", "a,b\n", "text/csv");

    expect(path).toBe(join(dir, "latest.csv"));
    expect(await readFile(path, "utf8")).toBe("a,b\n");
  });
});

describe("createSinkFromEnv", () => {
  it("selects local without S3_BUCKET and S3 with it", async () => {
    const dir = await scratch();
    expect(createSinkFromEnv(dir, {}).description).toBe(dir);
    expect(createSinkFromEnv(dir, { S3_BUCKET: "bucket", S3_PREFIX: "data" }).description).toBe(
      "s3://bucket/data/",
    );
  });
});
