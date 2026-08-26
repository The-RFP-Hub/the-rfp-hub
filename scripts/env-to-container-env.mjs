// Turn one Secrets Manager value into the ECS task definition the deploy registers.
//
// THE IMAGE CARRIES NO CONFIGURATION (see the Dockerfile and scripts/check-deploy.mjs). Something
// still has to put `DATABASE_URL` in front of the container, and until the task definition grows a
// `secrets:` array — operator work in AWS, not repository work — this script is that something: the
// DEPLOY job reads the environment's secret, parses it here, and writes the pairs into the task
// definition's `environment` array before registering it. Nothing reaches the build context, no
// layer holds a value, and the public Actions cache holds nothing but code.
//
// The trade is deliberate and interim: `environment` values are readable by any principal that can
// call `ecs:DescribeTaskDefinition` in the account, and `RegisterTaskDefinition` sends them as
// CloudTrail request parameters. That is a smaller blast radius than a `mode=max` layer cache in a
// PUBLIC repository, and it is the only step that is ours alone to take. packages/api/docs/deploy.md
// §2 records the exposure and the one-line migration off it.
//
// ── TWO MODES ──────────────────────────────────────────────────────────────────────────────────
//
//   parse   secret text on STDIN → a JSON `[{name, value}, …]` array at --out
//           node scripts/env-to-container-env.mjs --out env.json --skip PORT,NODE_ENV \
//             --require DATABASE_URL,BETTER_AUTH_SECRET
//
//   inject  a describe-task-definition document + that array → the document to register
//           node scripts/env-to-container-env.mjs --inject task-definition.json \
//             --container rfp-hub-staging --image <uri> --env env.json --out rendered.json
//
// The secret is read from STDIN and never from a path or an argument: an argument is in the process
// table and a path is a file somebody forgets to delete.
//
// ── WHY NODE AND NOT jq / THE RENDER ACTION ────────────────────────────────────────────────────
//
// The deploy job runs no `pnpm install`, so this uses Node builtins only — nothing here imports
// anything the runner does not already have.
//
// `aws-actions/amazon-ecs-render-task-definition` is deliberately NOT in the pipeline any more. It
// writes the whole task definition through `core.debug`, which means a run with step debugging
// enabled prints the PREVIOUS revision's environment — values this run's masks do not cover, since
// a rotation makes them different strings. Doing the image and the environment in one pass here
// means no third-party action ever reads a document carrying plaintext. Its `environment-variables:`
// input would not have been enough anyway: it splits on physical newlines and keeps everything
// after the first `=`, so it implements neither dotenv quoting nor multi-line values, and it MERGES
// rather than replaces — a variable deleted from Secrets Manager would live on in the task
// definition forever.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * dotenv's parser, vendored VERBATIM from dotenv@17's `lib/main.js`.
 *
 * `packages/api/src/config.ts` calls `dotenv.config()`, and since the Dockerfile's `CMD` lost its
 * `--env-file-if-exists` flag, dotenv is the only parser the application has. So the rule for this
 * file is: if dotenv and anything else disagree about what a line means, dotenv wins, because
 * dotenv is what the developer's local `.env` is read with. Copying the implementation rather than
 * importing it is what makes that true in the deploy job, which has no `node_modules`; the
 * differential test in `env-to-container-env.test.mjs` is what keeps the copy honest.
 */
const LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

/** Parse dotenv source into a plain object. Last occurrence of a name wins; nothing is expanded. */
export function parseEnv(src) {
  const obj = {};
  let lines = src.toString();
  lines = lines.replace(/\r\n?/gm, "\n");

  LINE.lastIndex = 0;
  let match = LINE.exec(lines);
  while (match != null) {
    const key = match[1];
    let value = match[2] || "";
    value = value.trim();
    const maybeQuote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (maybeQuote === '"') {
      value = value.replace(/\\n/g, "\n");
      value = value.replace(/\\r/g, "\r");
    }
    obj[key] = value;
    match = LINE.exec(lines);
  }
  LINE.lastIndex = 0;
  return obj;
}

/**
 * `escapeData` from actions/toolkit — the escaping every workflow command needs.
 *
 * A `%` in a value would otherwise be read back as the start of one of these escapes, and a raw CR
 * or LF would end the command early and register a mask for half a secret. Copied rather than
 * approximated because the receiving end is GitHub's parser, not ours.
 */
export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Register a mask for every line of a value.
 *
 * PER LINE because the runner matches masks against log lines: a mask carrying `%0A` matches
 * nothing, so a multi-line value (a PEM key, a JSON blob) would go through unmasked if it were
 * registered whole.
 *
 * EVERY non-empty value, with no cleverness about which ones look like credentials. `123456`,
 * `true` and a four-character string are all things a secret store legitimately holds, and the
 * parser has no way to tell a port from a PIN. The cost is that a short, common value also gets
 * starred out where it appears innocently elsewhere in the log; the alternative is deciding on a
 * deploy runner which of somebody's secrets are not really secrets.
 */
export function maskValue(value, mask) {
  for (const line of String(value ?? "").split("\n")) {
    if (line.length > 0) mask(`::add-mask::${escapeData(line)}`);
  }
}

/**
 * Names ECS or the AWS SDKs own inside the container.
 *
 * `AWS_CONTAINER_CREDENTIALS_*` and the ECS metadata URIs are how the task role is delivered: a
 * value from the secret landing on one of them would either break credential resolution or point
 * the SDK at an attacker-chosen endpoint. `AWS_REGION` and the static-key trio are the same story
 * one level up. None of them belongs in a deployment's own configuration, so finding one is a
 * mistake worth failing on rather than quietly dropping.
 */
export const AWS_MANAGED_NAMES = new Set([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_EXECUTION_ENV",
  "ECS_CONTAINER_METADATA_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
  "ECS_AGENT_URI",
]);

/**
 * A POSIX environment-variable name. Stricter than dotenv's own `[\w.-]+`, which accepts `1FOO`
 * and `foo.bar` — neither of which a shell can export and neither of which ECS accepts.
 */
export const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Extra conditions a `--require`d name has to meet, beyond being present and non-blank.
 *
 * `BETTER_AUTH_SECRET` is the only one so far: `src/config.ts` refuses to boot under
 * `NODE_ENV=production` without at least 32 characters, and finding that out from a crash-looping
 * task is strictly worse than finding it out here, where the old revision is still serving.
 */
const REQUIRED_VALUE_RULES = {
  BETTER_AUTH_SECRET: (value) =>
    value.length < 32
      ? `BETTER_AUTH_SECRET is ${value.length} characters; the service refuses to boot under NODE_ENV=production with fewer than 32`
      : null,
};

/** ECS's hard ceiling on a registered task definition, and the room this script leaves under it. */
export const MAX_TASK_DEFINITION_BYTES = 64 * 1024;
export const TASK_DEFINITION_MARGIN_BYTES = 2 * 1024;

/**
 * Fields `DescribeTaskDefinition` returns that `RegisterTaskDefinition` rejects.
 *
 * The deploy action strips these itself, with a `core.warning` for each — this list is its list.
 * Stripping them here keeps six warnings out of every deploy log AND makes the size check below
 * measure the document that is actually registered rather than a larger one that never is.
 */
export const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  "compatibilities",
  "taskDefinitionArn",
  "requiresAttributes",
  "revision",
  "status",
  "registeredAt",
  "deregisteredAt",
  "registeredBy",
];

/**
 * Secret text → the `environment` array, with every value masked before anything else happens.
 *
 * The ordering is the whole security property: parse, then mask, then validate, then return. A
 * validation error names a KEY, and by the time one can be thrown every VALUE is already masked —
 * so no failure path, however unexpected, can put a secret in the log.
 *
 * @param text     the raw SecretString
 * @param skip     names the image already sets, left out so the image keeps winning
 * @param required names whose absence must fail the deploy instead of the container
 * @param mask     sink for `::add-mask::` commands; must reach the log before any other output
 */
export function toContainerEnv(text, { skip = [], required = [], mask = () => {} } = {}) {
  const parsed = parseEnv(text);

  for (const value of Object.values(parsed)) maskValue(value, mask);

  const skipSet = new Set(skip);
  const entries = [];
  const skipped = [];
  const dropped = [];

  for (const [name, value] of Object.entries(parsed)) {
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `${JSON.stringify(name)} is not a usable environment-variable name (letters, digits and _, not starting with a digit). Fix the secret; a name ECS accepts is not the same as a name dotenv parses.`,
      );
    }
    if (AWS_MANAGED_NAMES.has(name)) {
      throw new Error(
        `${name} is set by ECS or the AWS SDK inside the container and must not come from the secret — overriding it breaks task-role credentials or redirects them. Remove it from the secret.`,
      );
    }
    if (skipSet.has(name)) {
      skipped.push(name);
      continue;
    }
    // An empty value is not a variable. `readOptional` in src/config.ts already treats "" as
    // unset, and the deploy action's own `cleanNullKeys` pass would strip the `value` key from
    // such an entry, leaving `{name}` alone — which RegisterTaskDefinition will not take.
    if (value === "") {
      dropped.push(name);
      continue;
    }
    entries.push({ name, value });
  }

  for (const name of required) {
    const value = parsed[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `${name} is missing or blank in the secret. The container would boot without it, so the deploy stops here and the previous revision keeps serving.`,
      );
    }
    if (skipSet.has(name)) {
      throw new Error(
        `${name} is both --require'd and --skip'ped, so it would be demanded and then left out. Pick one.`,
      );
    }
    const problem = REQUIRED_VALUE_RULES[name]?.(value);
    if (problem) throw new Error(problem);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  skipped.sort();
  dropped.sort();
  return { entries, skipped, dropped };
}

/**
 * Put the new image and the parsed environment into the downloaded task definition.
 *
 * Exactly one container may carry the name: zero means the family was renamed under the workflow's
 * feet, and more than one means a sidecar shares the service's name — in both cases guessing which
 * one gets the database URL is worse than stopping.
 *
 * The environment is REPLACED, not merged, because Secrets Manager is the single source of truth
 * for it: a variable deleted there has to disappear from the container too, and a merge would
 * carry it forever.
 *
 * `environment` is OPTIONAL, and leaving it out is the migration off this script: once the values
 * live in the task definition's `secrets:` array, the deploy drops the parse step and this call
 * sets the image and nothing else — which is all the action it replaced ever did.
 */
export function injectContainerEnv(
  taskDefinition,
  { container, image, environment, mask = () => {} },
) {
  const doc = structuredClone(taskDefinition);
  const definitions = doc.containerDefinitions;
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error("the task definition has no containerDefinitions array");
  }

  // The document that came back from `describe-task-definition` is the PREVIOUS revision, and
  // after the first injected deploy that revision carries plaintext of its own. Those values are
  // masked here — before any selection can fail — because after a rotation they are different
  // strings from the ones the parse step masked, and nothing else in this job would cover them.
  for (const definition of definitions) {
    for (const entry of definition?.environment ?? []) maskValue(entry?.value, mask);
  }

  const matches = definitions.filter((definition) => definition?.name === container);
  if (matches.length !== 1) {
    const names = definitions.map((definition) => definition?.name).join(", ");
    throw new Error(
      `expected exactly one container named ${container}, found ${matches.length} (the task definition defines: ${names})`,
    );
  }
  const target = matches[0];

  // A name in both lists is ECS resolving one of them and silently ignoring the other. During a
  // migration to `secrets:` that is exactly the shape a half-finished move takes, so it fails
  // loudly instead of deploying a container configured by a coin flip.
  const secretNames = new Set((target.secrets ?? []).map((entry) => entry?.name));
  const clashes = (environment ?? [])
    .map((entry) => entry.name)
    .filter((name) => secretNames.has(name));
  if (clashes.length > 0) {
    throw new Error(
      `${clashes.join(", ")} appear(s) in both the container's secrets: array and the injected environment. Remove ${clashes.length > 1 ? "them" : "it"} from the secret — a value already wired through secrets: does not need the plaintext copy.`,
    );
  }

  target.image = image;
  if (environment !== undefined) {
    target.environment = environment.map(({ name, value }) => ({ name, value }));
  } else {
    // No `--env` is the post-migration shape: the deploy no longer writes plaintext. What the
    // previous revision carried in `environment` is then either an operator-managed non-secret
    // setting (kept) or a leftover plaintext copy of something that now arrives through
    // `secrets:` (dropped — re-registering it would keep the exposure this migration ends).
    target.environment = (target.environment ?? []).filter(
      (entry) => !secretNames.has(entry?.name),
    );
  }
  for (const attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) delete doc[attribute];

  const json = JSON.stringify(doc);
  const bytes = Buffer.byteLength(json, "utf8");
  const limit = MAX_TASK_DEFINITION_BYTES - TASK_DEFINITION_MARGIN_BYTES;
  if (bytes > limit) {
    throw new Error(
      `the rendered task definition is ${bytes} bytes; ECS accepts at most ${MAX_TASK_DEFINITION_BYTES} and this check leaves ${TASK_DEFINITION_MARGIN_BYTES} bytes of margin. Move the largest values into the task definition's secrets: array (packages/api/docs/deploy.md §2).`,
    );
  }

  return { taskDefinition: doc, json, bytes };
}

/** Write a file only its owner can read. Every path this script writes carries plaintext. */
function writePrivate(path, contents) {
  // Unlinked first because `mode:` only applies to a file this call CREATES: writing over an
  // existing path would keep whatever permissions it already had.
  rmSync(path, { force: true });
  writeFileSync(path, contents, { mode: 0o600, flag: "w" });
}

const list = (value) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      skip: { type: "string", default: "PORT,NODE_ENV" },
      require: { type: "string", default: "DATABASE_URL,BETTER_AUTH_SECRET" },
      inject: { type: "string" },
      container: { type: "string" },
      image: { type: "string" },
      env: { type: "string" },
    },
  });

  if (!values.out) {
    console.error("--out <path> is required");
    process.exit(2);
  }

  // Masks go out through stdout immediately, unbuffered by anything of ours: a mask registered
  // after the value has already been printed does nothing, which is the one ordering GitHub
  // documents as unrecoverable.
  const mask = (command) => process.stdout.write(`${command}\n`);

  if (values.inject) {
    for (const flag of ["container", "image"]) {
      if (!values[flag]) {
        console.error(`--${flag} is required with --inject`);
        process.exit(2);
      }
    }
    const taskDefinition = JSON.parse(readFileSync(values.inject, "utf8"));
    // No --env is the post-migration shape: the values are in `secrets:` and this only sets the
    // image, leaving whatever `environment` the downloaded definition carries untouched.
    const environment = values.env ? JSON.parse(readFileSync(values.env, "utf8")) : undefined;
    const { json, bytes } = injectContainerEnv(taskDefinition, {
      container: values.container,
      image: values.image,
      environment,
      mask,
    });
    writePrivate(values.out, json);
    const wrote = environment
      ? `${environment.length} environment entr${environment.length === 1 ? "y" : "ies"}`
      : "environment left as it was";
    console.log(`✓ rendered ${values.container}: image ${values.image}, ${wrote}, ${bytes} bytes`);
    return;
  }

  const { entries, skipped, dropped } = toContainerEnv(readFileSync(0, "utf8"), {
    skip: list(values.skip),
    required: list(values.require),
    mask,
  });

  writePrivate(values.out, JSON.stringify(entries));

  // NAMES only, never values — the point of the whole step. The names are worth printing: they
  // are how an operator reads a deploy log and sees that a variable they added actually shipped.
  console.log(`✓ ${entries.length} variable(s) for containerDefinitions[].environment:`);
  console.log(`    ${entries.map((entry) => entry.name).join(", ")}`);
  if (skipped.length > 0) {
    console.log(`  left to the image (--skip): ${skipped.join(", ")}`);
  }
  if (dropped.length > 0) {
    console.log(`  dropped, empty value in the secret: ${dropped.join(", ")}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
