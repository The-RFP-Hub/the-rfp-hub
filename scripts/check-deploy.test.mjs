/**
 * THE RULE: a secret must never be reachable from the container image or its layer cache.
 *
 * The regression this guards is not hypothetical — it is the state this repository was in, and it
 * is one line in each of three files. The cases below are written against the forms that line
 * actually takes, because a check that only recognises the exact wording it was written for is a
 * check that passes the day someone rewrites it slightly.
 *
 * The last two cases run against the REAL files. That is the point of the whole script: a unit
 * test over strings proves the patterns, and only reading the tree proves the tree.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_DOCKERIGNORE,
  scanDockerfile,
  scanDockerignore,
  scanWorkflow,
} from "./check-deploy.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");

describe("the Dockerfile", () => {
  it("catches an env file being copied into the image, in every form the instruction takes", () => {
    for (const line of [
      "COPY .env* ./",
      "COPY .env .env",
      "COPY --chown=node:node ./.env /app/.env",
      "ADD packages/api/.env .",
      "copy .env* ./",
    ]) {
      expect(scanDockerfile(`FROM node:22\n${line}\n`), line).toHaveLength(1);
    }
  });

  it("catches --env-file, which only pays off if a file was baked in", () => {
    const hits = scanDockerfile('CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toMatch(/start-up/);
  });

  // The fix is documented in prose right where the instruction used to be, so the checker has to
  // read a comment as a comment. Otherwise explaining the rule would violate it.
  it("does not fire on comments that describe the rule, or on ordinary copies", () => {
    expect(
      scanDockerfile(
        [
          "# NO SECRETS ARE BAKED INTO THIS IMAGE — there is deliberately no `COPY .env*` here",
          "#   and no --env-file flag on the CMD below.",
          "COPY package.json pnpm-lock.yaml ./",
          "COPY packages ./packages",
          'CMD ["node", "packages/api/dist/server.js"]',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe(".dockerignore", () => {
  it("requires every env pattern, and names the ones that went missing", () => {
    const hits = scanDockerignore(".git\nnode_modules\n.env\n**/.env\n");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain(".env.*");
    expect(hits[0].message).toContain("**/.env.*");
  });

  it("accepts the full set, around comments and blank lines", () => {
    expect(scanDockerignore(`# secrets\n\n${REQUIRED_DOCKERIGNORE.join("\n")}\n`)).toEqual([]);
  });

  it("rejects a negation that re-includes an env file after the exclusions", () => {
    const text = `${REQUIRED_DOCKERIGNORE.join("\n")}\n!packages/api/.env\n!**/.env.local\n!dist\n`;
    const hits = scanDockerignore(text);
    expect(hits.map((h) => h.message)).toEqual([
      expect.stringContaining("!packages/api/.env"),
      expect.stringContaining("!**/.env.local"),
    ]);
  });
});

describe("the deploy workflows", () => {
  it("catches a secret being written into an env file in the build context", () => {
    for (const line of [
      "          aws secretsmanager get-secret-value --secret-id staging/rfp-hub --query SecretString --output text >> .env",
      "        run: echo $SECRET > ./.env",
      "        run: printf '%s' \"$VALUE\" >> packages/api/.env.production",
    ]) {
      expect(scanWorkflow(line, "w.yml"), line).toHaveLength(1);
    }
  });

  it("does not fire on a comment explaining why the step is gone", () => {
    expect(
      scanWorkflow(
        "      # the step that wrote `>> .env` here was removed; see docs/deploy.md",
        "w.yml",
      ),
    ).toEqual([]);
  });
});

describe("this repository, as it stands", () => {
  it("bakes no env file into the image", () => {
    expect(scanDockerfile(read("Dockerfile"))).toEqual([]);
    expect(scanDockerignore(read(".dockerignore"))).toEqual([]);
  });

  it("fetches no secret into the build context in either deploy workflow", () => {
    for (const rel of [".github/workflows/staging.yml", ".github/workflows/production.yml"]) {
      expect(scanWorkflow(read(rel), rel), rel).toEqual([]);
    }
  });
});
