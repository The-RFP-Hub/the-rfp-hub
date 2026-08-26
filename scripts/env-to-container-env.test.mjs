/**
 * THE RULE: this script is the only thing standing between a Secrets Manager value and a public
 * deploy log, and the only thing that decides what the container is configured with.
 *
 * So there are two kinds of case below. The first kind is about the PARSE — a copy of dotenv's
 * regex is a copy, and a copy drifts, so the fixture set is run through the REAL dotenv from
 * `packages/api`'s dependencies and through Node's own `--env-file` parser as well, and the three
 * are compared. The second kind is about the LEAK: every value masked, masked before anything is
 * printed, masked per line, escaped the way the runner expects. A parser bug ships the wrong
 * config; a masking bug publishes a credential.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AWS_MANAGED_NAMES,
  MAX_TASK_DEFINITION_BYTES,
  escapeData,
  injectContainerEnv,
  maskValue,
  parseEnv,
  toContainerEnv,
} from "./env-to-container-env.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** dotenv is a dependency of `packages/api`, not of the root, so it is resolved from there. */
const dotenv = createRequire(join(repoRoot, "packages/api/package.json"))("dotenv");

/** Collect what the script would write to the log instead of writing it. */
const collect = () => {
  const lines = [];
  return { lines, mask: (line) => lines.push(line) };
};

/**
 * Every line form that has ever meant something different to two dotenv-shaped parsers, in one
 * document — because the interesting cases are the ones a hand-written fixture leaves out.
 */
const FIXTURE = [
  "# a comment line",
  "",
  "BLANK=",
  "export EXPORTED=exported-value",
  "EQUALS=postgres://u:p@h/db?x=1&y=2",
  "SINGLE='single #not-comment'",
  'DOUBLE="double #not-comment"',
  "BACKTICK=`tick`",
  'NEWLINES="line1\\nline2"',
  "TRAILING=value # trailing comment",
  "DOLLAR=lit$eral${NOPE}",
  "SPACED   =   spaced-value",
  "DUP=first",
  "DUP=last",
  "NUMERIC=3004",
  "BOOL=true",
  'MULTILINE="first\nsecond"',
  "TRAILING_WS=  padded  ",
  "",
].join("\n");

/** The same document with CRLF endings: Secrets Manager stores whatever was pasted into it. */
const FIXTURE_CRLF = FIXTURE.replace(/\n/g, "\r\n");

describe("the parser", () => {
  it("reads every line form the way dotenv reads it", () => {
    expect(parseEnv(FIXTURE)).toEqual({
      BLANK: "",
      EXPORTED: "exported-value",
      EQUALS: "postgres://u:p@h/db?x=1&y=2",
      SINGLE: "single #not-comment",
      DOUBLE: "double #not-comment",
      BACKTICK: "tick",
      NEWLINES: "line1\nline2",
      TRAILING: "value",
      DOLLAR: "lit$eral${NOPE}",
      SPACED: "spaced-value",
      DUP: "last",
      NUMERIC: "3004",
      BOOL: "true",
      MULTILINE: "first\nsecond",
      TRAILING_WS: "padded",
    });
  });

  it("is byte-identical to the real dotenv, on LF and on CRLF", () => {
    expect(parseEnv(FIXTURE)).toEqual(dotenv.parse(FIXTURE));
    expect(parseEnv(FIXTURE_CRLF)).toEqual(dotenv.parse(FIXTURE_CRLF));
    expect(parseEnv(FIXTURE_CRLF)).toEqual(parseEnv(FIXTURE));
  });

  /**
   * Node's own parser matters because it is the OTHER thing that has ever read this secret: the
   * image's `CMD` carried `--env-file-if-exists=.env` until the deploy-hygiene change removed it.
   * On this fixture the two agree on everything except the `KEY: value` form, which dotenv accepts
   * and Node drops entirely.
   *
   * DOTENV WINS, deliberately: `packages/api/src/config.ts` calls `dotenv.config()` and nothing
   * passes `--env-file` any more, so dotenv is the only parser the application still has. A value
   * this script ships is a value the developer's local `.env` would have produced.
   */
  it("agrees with Node's --env-file parser everywhere except the `KEY: value` form", () => {
    const nodeParse = (text) => {
      const file = join(mkdtempSync(join(tmpdir(), "env-diff-")), ".env");
      writeFileSync(file, text);
      const raw = execFileSync(
        process.execPath,
        [`--env-file=${file}`, "-p", "JSON.stringify(process.env)"],
        {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
        },
      );
      return JSON.parse(raw);
    };

    const ours = parseEnv(FIXTURE);
    const theirs = nodeParse(FIXTURE);
    for (const [name, value] of Object.entries(ours)) {
      expect(theirs[name], name).toBe(value);
    }

    const colon = "COLON: colon-value\n";
    expect(parseEnv(colon)).toEqual({ COLON: "colon-value" });
    expect(dotenv.parse(colon)).toEqual({ COLON: "colon-value" });
    expect(nodeParse(colon).COLON).toBeUndefined();
  });
});

/** A describe-task-definition document, complete with the fields register rejects. */
const taskDefinition = ({ containers, environment = [], secrets = [] } = {}) => ({
  taskDefinitionArn: "arn:aws:ecs:us-east-1:1234:task-definition/rfp-hub-staging:41",
  family: "rfp-hub-staging",
  revision: 41,
  status: "ACTIVE",
  requiresAttributes: [{ name: "ecs.capability.execution-role-awslogs" }],
  compatibilities: ["EC2", "FARGATE"],
  registeredAt: "2026-08-26T00:00:00.000Z",
  registeredBy: "arn:aws:iam::1234:user/deploy",
  cpu: "512",
  memory: "1024",
  containerDefinitions: containers ?? [
    { name: "rfp-hub-staging", image: "old-image", environment, secrets },
  ],
});

describe("masking", () => {
  it("escapes exactly what the toolkit escapes", () => {
    expect(escapeData("100% \r\n done")).toBe("100%25 %0D%0A done");
  });

  it("registers one mask per line, so a multi-line value is covered", () => {
    const { lines, mask } = collect();
    maskValue("-----BEGIN KEY-----\nabc\n\ndef\n", mask);
    expect(lines).toEqual([
      "::add-mask::-----BEGIN KEY-----",
      "::add-mask::abc",
      "::add-mask::def",
    ]);
  });

  it("masks EVERY non-empty value, including the short, numeric and skipped ones", () => {
    const { lines, mask } = collect();
    toContainerEnv(
      "PORT=3004\nNODE_ENV=production\nFLAG=true\nEMPTY=\nDATABASE_URL=postgres://x\n",
      {
        skip: ["PORT", "NODE_ENV"],
        mask,
      },
    );
    expect(lines).toEqual([
      "::add-mask::3004",
      "::add-mask::production",
      "::add-mask::true",
      "::add-mask::postgres://x",
    ]);
  });

  /**
   * The ordering is the security property: a mask registered after the value was printed does
   * nothing. So every value must be masked before the first failure can be raised — a validation
   * error names a KEY, and by then the VALUES are already covered.
   */
  it("masks everything before it throws, not after", () => {
    const { lines, mask } = collect();
    expect(() =>
      toContainerEnv("GOOD=keep-me-secret\nAWS_SECRET_ACCESS_KEY=nope\n", { mask }),
    ).toThrow(/AWS_SECRET_ACCESS_KEY/);
    expect(lines).toContain("::add-mask::keep-me-secret");
  });

  it("masks the previous revision's values too, before touching the document", () => {
    const { lines, mask } = collect();
    injectContainerEnv(taskDefinition({ environment: [{ name: "OLD", value: "rotated-away" }] }), {
      container: "rfp-hub-staging",
      image: "img",
      environment: [{ name: "NEW", value: "current" }],
      mask,
    });
    expect(lines).toContain("::add-mask::rotated-away");
  });
});

describe("the environment array", () => {
  const secret = [
    "PORT=9999",
    "NODE_ENV=development",
    "DATABASE_URL=postgres://runtime@db/rfphub",
    `BETTER_AUTH_SECRET=${"s".repeat(32)}`,
    "EMAIL_TRANSPORT=ses",
    "EMPTY=",
  ].join("\n");

  it("leaves the image's own PORT and NODE_ENV alone, and drops empty values", () => {
    const { entries, skipped, dropped } = toContainerEnv(secret, {
      skip: ["PORT", "NODE_ENV"],
      required: ["DATABASE_URL", "BETTER_AUTH_SECRET"],
    });
    expect(entries.map((e) => e.name)).toEqual([
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "EMAIL_TRANSPORT",
    ]);
    expect(skipped).toEqual(["NODE_ENV", "PORT"]);
    expect(dropped).toEqual(["EMPTY"]);
  });

  it("fails on a required name that is absent, blank, or too short to work", () => {
    expect(() => toContainerEnv("OTHER=x\n", { required: ["DATABASE_URL"] })).toThrow(
      /DATABASE_URL is missing or blank/,
    );
    expect(() => toContainerEnv("DATABASE_URL=   \n", { required: ["DATABASE_URL"] })).toThrow(
      /DATABASE_URL is missing or blank/,
    );
    expect(() =>
      toContainerEnv(`BETTER_AUTH_SECRET=${"s".repeat(31)}\n`, {
        required: ["BETTER_AUTH_SECRET"],
      }),
    ).toThrow(/31 characters/);
    expect(
      toContainerEnv(`BETTER_AUTH_SECRET=${"s".repeat(32)}\n`, {
        required: ["BETTER_AUTH_SECRET"],
      }).entries,
    ).toHaveLength(1);
  });

  it("refuses a name that is required and skipped at once", () => {
    expect(() =>
      toContainerEnv("DATABASE_URL=x\n", { skip: ["DATABASE_URL"], required: ["DATABASE_URL"] }),
    ).toThrow(/Pick one/);
  });

  it("refuses a name no shell could export", () => {
    for (const line of ["1FOO=x", "foo.bar=x", "with-dash=x"]) {
      expect(() => toContainerEnv(`${line}\n`), line).toThrow(/not a usable environment-variable/);
    }
  });

  it("refuses every name ECS or the AWS SDK owns inside the container", () => {
    for (const name of AWS_MANAGED_NAMES) {
      expect(() => toContainerEnv(`${name}=x\n`), name).toThrow(/set by ECS or the AWS SDK/);
    }
  });
});

describe("rendering the task definition", () => {
  const render = (doc, environment) =>
    injectContainerEnv(doc, { container: "rfp-hub-staging", image: "new-image", environment });

  it("sets the image, replaces the environment wholesale, and drops the describe-only fields", () => {
    const { taskDefinition: out } = render(
      taskDefinition({ environment: [{ name: "GONE", value: "removed from the secret" }] }),
      [{ name: "DATABASE_URL", value: "postgres://x" }],
    );
    const container = out.containerDefinitions[0];
    expect(container.image).toBe("new-image");
    expect(container.environment).toEqual([{ name: "DATABASE_URL", value: "postgres://x" }]);
    for (const attribute of ["taskDefinitionArn", "revision", "status", "compatibilities"]) {
      expect(out, attribute).not.toHaveProperty(attribute);
    }
    expect(out.family).toBe("rfp-hub-staging");
  });

  it("sets only the image when no environment is passed — the post-migration shape", () => {
    const before = [{ name: "KEPT", value: "from the previous revision" }];
    const { taskDefinition: out } = injectContainerEnv(taskDefinition({ environment: before }), {
      container: "rfp-hub-staging",
      image: "new-image",
    });
    expect(out.containerDefinitions[0].image).toBe("new-image");
    expect(out.containerDefinitions[0].environment).toEqual(before);
  });

  it("requires exactly one container with the name", () => {
    expect(() => render(taskDefinition({ containers: [{ name: "sidecar" }] }), [])).toThrow(
      /exactly one container named rfp-hub-staging, found 0/,
    );
    expect(() =>
      render(
        taskDefinition({ containers: [{ name: "rfp-hub-staging" }, { name: "rfp-hub-staging" }] }),
        [],
      ),
    ).toThrow(/found 2/);
  });

  /**
   * The migration OFF this script is incremental: a name moves into `secrets:` and out of the
   * secret. Between those two edits the name is in both lists, ECS resolves one and ignores the
   * other, and which one it resolves is not something to find out in production.
   */
  it("refuses a name that is in both environment and secrets", () => {
    expect(() =>
      render(taskDefinition({ secrets: [{ name: "DATABASE_URL", valueFrom: "arn:…" }] }), [
        { name: "DATABASE_URL", value: "postgres://x" },
      ]),
    ).toThrow(/both the container's secrets: array and the injected environment/);
  });

  it("refuses a document ECS would reject for size", () => {
    const big = [{ name: "HUGE", value: "x".repeat(MAX_TASK_DEFINITION_BYTES) }];
    expect(() => render(taskDefinition(), big)).toThrow(/ECS accepts at most/);
    const ok = render(taskDefinition(), [{ name: "SMALL", value: "x".repeat(1024) }]);
    expect(ok.bytes).toBeLessThan(MAX_TASK_DEFINITION_BYTES);
    expect(JSON.parse(ok.json).containerDefinitions[0].environment[0].name).toBe("SMALL");
  });
});
