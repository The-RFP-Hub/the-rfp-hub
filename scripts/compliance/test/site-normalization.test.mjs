/**
 * `--site` is normalized the way `--api` is. Untrimmed, `https://host/` built
 * `https://host//publishers`; unvalidated, a non-URL threw from inside a criterion mid-run.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BINARY = fileURLToPath(new URL("../../check-deployment.mjs", import.meta.url));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BINARY, ...args], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

const offlineDocs = (site) => [
  "--only",
  "docs",
  "--offline",
  "--site",
  site,
  "--json",
  "-",
  "--no-color",
];

describe("--site", () => {
  it("drops a trailing slash, so no URL is built with a doubled separator", async () => {
    const { out } = await run(offlineDocs("https://staging.example.org/"));
    expect(out).toContain("Site             https://staging.example.org\n");
    expect(out).not.toContain("https://staging.example.org/\n");
  });

  it("refuses a malformed value before the run, rather than throwing mid-criterion", async () => {
    const { code, out } = await run(offlineDocs("staging.example.org"));
    expect(code).toBe(2);
    expect(out).toContain("--site must be an absolute URL");
    expect(out).not.toContain("unexpected failure");
  });

  it("ignores --site entirely when no selected criterion reads it (liveness needs only the API)", async () => {
    const { code, out } = await run([
      "--only",
      "liveness",
      "--offline",
      "--site",
      "not-a-url",
      "--json",
      "-",
      "--no-color",
    ]);
    expect(out).not.toContain("--site must be an absolute URL");
    expect(code).toBe(1); // offline grounds liveness: unmet, not refused
  });
});
