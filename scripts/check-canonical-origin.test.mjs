/**
 * The guard exists because the failure it catches is SILENT: with Vercel's system variables not
 * exposed and no explicit `NEXT_PUBLIC_SITE_ORIGIN`, a production deploy is green and the site is
 * `noindex`. So two kinds of case below. The first is the truth table — every way an environment
 * can and cannot name a canonical origin. The second pins `packages/frontend/src/lib/site-origin.ts`
 * against it: a guard that has drifted from the rule it guards is worse than no guard, because the
 * green check now means nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXPOSE_SETTING, resolveCanonicalOrigin } from "./check-canonical-origin.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repoRoot, "scripts", "check-canonical-origin.mjs");

const VERCEL_PRODUCTION = {
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "ethrfps.app",
};

function runGuard(envFileText, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "rfphub-canonical-origin-"));
  const path = join(dir, ".env.local");
  writeFileSync(path, envFileText);
  try {
    const stdout = execFileSync(process.execPath, [script, path, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("resolveCanonicalOrigin", () => {
  it("derives the origin from Vercel's production environment", () => {
    expect(resolveCanonicalOrigin(VERCEL_PRODUCTION)).toEqual({
      origin: "https://ethrfps.app",
      source: "VERCEL_PROJECT_PRODUCTION_URL",
    });
  });

  it("names no origin on a preview, which is what keeps every preview out of the index", () => {
    const result = resolveCanonicalOrigin({ ...VERCEL_PRODUCTION, VERCEL_ENV: "preview" });
    expect(result.origin).toBeNull();
    expect(result.reason).toContain('not "production"');
  });

  it("names the exposure setting when VERCEL_ENV is absent entirely — the silent failure", () => {
    const result = resolveCanonicalOrigin({});
    expect(result.origin).toBeNull();
    expect(result.reason).toContain(EXPOSE_SETTING);
  });

  it("names the exposure setting when production exposes no production URL", () => {
    const result = resolveCanonicalOrigin({ VERCEL_ENV: "production" });
    expect(result.origin).toBeNull();
    expect(result.reason).toContain(EXPOSE_SETTING);
  });

  it("lets an explicit value win over Vercel's production domain", () => {
    expect(
      resolveCanonicalOrigin({
        ...VERCEL_PRODUCTION,
        NEXT_PUBLIC_SITE_ORIGIN: "https://mirror.example.org/",
      }),
    ).toEqual({ origin: "https://mirror.example.org", source: "NEXT_PUBLIC_SITE_ORIGIN" });
  });

  it("refuses a malformed explicit value instead of falling back to Vercel's", () => {
    const result = resolveCanonicalOrigin({
      ...VERCEL_PRODUCTION,
      NEXT_PUBLIC_SITE_ORIGIN: "ethrfps.app",
    });
    expect(result.origin).toBeNull();
    expect(result.reason).toContain("wins over Vercel's own variables");
  });

  it("names no origin off Vercel with nothing declared", () => {
    expect(
      resolveCanonicalOrigin({ NEXT_PUBLIC_API_URL: "https://api.ethrfps.app" }).origin,
    ).toBeNull();
  });
});

describe("the guard as the workflow runs it", () => {
  it("passes and prints the resolved origin for a production environment", () => {
    const { code, stdout } = runGuard(
      'VERCEL_ENV="production"\nVERCEL_PROJECT_PRODUCTION_URL="ethrfps.app"\n',
    );
    expect(code).toBe(0);
    expect(stdout).toContain(
      "canonical origin: https://ethrfps.app (from VERCEL_PROJECT_PRODUCTION_URL)",
    );
  });

  it("says which variables the pull carried, and never their values, when production names no URL", () => {
    const { code, stderr } = runGuard(
      'VERCEL="1"\nVERCEL_ENV="production"\nVERCEL_TARGET_ENV="production"\nNEXT_PUBLIC_API_URL="https://api.ethrfps.app"\nNEXT_PUBLIC_GA_ID="G-SECRET"\n',
    );
    expect(code).toBe(1);
    expect(stderr).toContain("VERCEL_PROJECT_PRODUCTION_URL is absent");
    expect(stderr).toContain(
      "The pulled file names: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_GA_ID, VERCEL, VERCEL_ENV, VERCEL_TARGET_ENV (values withheld)",
    );
    expect(stderr).not.toContain("G-SECRET");
    expect(stderr).not.toContain("api.ethrfps.app");
  });

  it("fails the production build when the system variables were never exposed", () => {
    const { code, stderr } = runGuard('NEXT_PUBLIC_API_URL="https://api.ethrfps.app"\n');
    expect(code).toBe(1);
    expect(stderr).toContain("::error::");
    expect(stderr).toContain("asks search engines not to index it");
    expect(stderr).toContain(EXPOSE_SETTING);
  });

  it("passes --expect none for a preview environment that claims nothing", () => {
    const { code, stdout } = runGuard('VERCEL_ENV="preview"\n', ["--expect", "none"]);
    expect(code).toBe(0);
    expect(stdout).toContain("canonical origin: none");
  });

  it("fails --expect none when a preview was given an origin of its own", () => {
    const { code, stderr } = runGuard('NEXT_PUBLIC_SITE_ORIGIN="https://ethrfps.app"\n', [
      "--expect",
      "none",
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("would index itself and compete with production");
  });

  it("exits 2, distinctly from a failed assertion, when `vercel pull` left no file", () => {
    let code;
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, join(tmpdir(), "definitely-absent.env")], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      code = 0;
    } catch (error) {
      code = error.status;
      stderr = error.stderr ?? "";
    }
    expect(code).toBe(2);
    expect(stderr).toContain("::error::cannot read");
  });
});

describe("the frontend's own rule, pinned", () => {
  const source = readFileSync(
    join(repoRoot, "packages", "frontend", "src", "lib", "site-origin.ts"),
    "utf8",
  );

  it("still reads exactly the three variables this guard reasons about", () => {
    expect(source).toContain("process.env.NEXT_PUBLIC_SITE_ORIGIN");
    expect(source).toContain('process.env.VERCEL_ENV !== "production"');
    expect(source).toContain("process.env.VERCEL_PROJECT_PRODUCTION_URL");
  });

  it("still lets the explicit variable short-circuit the Vercel fallback", () => {
    expect(source).toContain("process.env.NEXT_PUBLIC_SITE_ORIGIN || vercelProductionOrigin()");
  });
});
