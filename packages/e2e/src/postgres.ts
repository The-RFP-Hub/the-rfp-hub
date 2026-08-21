/**
 * Disposable Postgres for one E2E run.
 *
 * Wraps `docker-compose.e2e.yml` — a run-scoped compose project and container, a dynamically
 * assigned host port read back rather than guessed — and the two-role setup the suite depends on:
 * an admin/migration role (used only by the runner itself, for migrate / role creation / direct
 * assertions) and a restricted runtime role the API processes actually run on, so a missing GRANT
 * shows up as a real 500 from a real route rather than being masked by an over-privileged
 * connection.
 *
 * Nothing here decides WHEN to call these — that bring-up/tear-down choreography belongs to the
 * external runner (`src/run.ts`). This module only knows how to stand up, prove disposable, and
 * tear down one Postgres instance.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const composeFile = join(here, "..", "docker-compose.e2e.yml");
const hardenAuditSqlPath = join(here, "..", "..", "api", "scripts", "sql", "harden-audit.sql");
const grantAuthSqlPath = join(here, "..", "..", "api", "scripts", "sql", "grant-auth.sql");

/**
 * The four tables the session library owns.
 *
 * They are named here for one purpose: to be REVOKED from the runtime role immediately after the
 * blanket grant, so that `grant-auth.sql` is the only thing that can make them reachable. See
 * `createRestrictedRole`.
 */
const AUTH_TABLES = ["auth_user", "auth_session", "auth_account", "auth_verification"] as const;

/**
 * Ports this suite must never bind or connect to, because each one already names a KNOWN,
 * non-disposable (or differently-disposable) database in this repo: 5432 is the persistent dev
 * database (`docker-compose.yml` at the repo root), 5433/5434 are reserved alongside it, and 5439
 * is `packages/api/docker-compose.test.yml`'s own throwaway database — a real database, just not
 * THIS run's. The E2E database must always bind a dynamic port, discovered after the fact.
 */
const FORBIDDEN_PORTS = new Set([5432, 5433, 5434, 5439]);

/** A safe charset for anything interpolated into a container name, project name or role name. */
const SAFE_RUN_ID = /^[a-z0-9-]{1,40}$/i;

export interface DisposablePostgres {
  runId: string;
  projectName: string;
  containerName: string;
  host: string;
  port: number;
  /** Admin/migration connection — the runner's own use only. Never handed to an API process. */
  adminUrl: string;
}

export interface RestrictedRole {
  role: string;
  password: string;
  /** The connection string the API processes are given. Least privilege, on purpose. */
  runtimeUrl: string;
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(
      `postgres.ts: run id "${runId}" is not safe to interpolate into a container/role/project name ` +
        `(expected ${SAFE_RUN_ID}).`,
    );
  }
}

function runScopedNames(runId: string): { projectName: string; containerName: string } {
  assertSafeRunId(runId);
  return {
    projectName: `rfphub-e2e-${runId}`,
    containerName: `rfphub-e2e-pg-${runId}`,
  };
}

function composeArgs(projectName: string, extra: string[]): string[] {
  return ["compose", "-p", projectName, "-f", composeFile, ...extra];
}

/**
 * Brings up this run's disposable Postgres, waits for its healthcheck, and reads back the host
 * port Docker actually assigned (`docker-compose.e2e.yml` binds `127.0.0.1::5432` — a dynamic
 * port — specifically so there is no window between choosing a port and the container claiming
 * it). Runs `assertDisposable` on the resulting URL before returning it, so a caller can never
 * receive a connection string this module has not already proven safe.
 */
export async function up(runId: string): Promise<DisposablePostgres> {
  const { projectName, containerName } = runScopedNames(runId);
  const env = { ...process.env, E2E_PG_CONTAINER: containerName };

  // `up --wait` can FAIL with the project already half-created: the container exists but its
  // healthcheck never went green. compose does not clean up after a failed --wait, and the
  // runner's finally cannot (ctx.pg is only assigned from this function's return) — so the
  // failure path here owns the teardown, exactly like the post-up block below.
  try {
    await execFileAsync("docker", composeArgs(projectName, ["up", "-d", "--wait"]), { env });
  } catch (err) {
    try {
      await down({ projectName, containerName });
    } catch (cleanupError) {
      throw new Error(
        `${(err as Error).message}\n  …and the half-created project could not be removed either: ${(cleanupError as Error).message}\n  Remove it by hand: docker rm -f ${containerName}`,
      );
    }
    throw err;
  }

  // FROM HERE ON THE CONTAINER EXISTS, so every failure path has to remove it.
  //
  // The runner's own `finally` cannot: it tears down `ctx.pg`, and `ctx.pg` is assigned from this
  // function's RETURN VALUE. Anything that throws between the `up` above and that return — an
  // unparseable port mapping, a failed disposability assertion — would therefore leave a running
  // container that nothing owns and nothing will ever clean up. The names are already known here,
  // which makes this the only place that can close it.
  try {
    const { stdout } = await execFileAsync(
      "docker",
      composeArgs(projectName, ["port", "postgres", "5432"]),
      { env },
    );
    const port = parseMappedPort(stdout);
    const host = "127.0.0.1";
    const adminUrl = `postgres://rfphub:rfphub@${host}:${port}/rfphub`;

    assertDisposable(adminUrl, { runId, containerName });

    return { runId, projectName, containerName, host, port, adminUrl };
  } catch (err) {
    try {
      await down({ projectName, containerName });
    } catch (cleanupError) {
      // The original failure is the one worth reporting; a failed cleanup is appended to it rather
      // than replacing it, because losing the cause would make this much harder to diagnose.
      throw new Error(
        `${(err as Error).message}\n  …and the container could not be removed either: ${(cleanupError as Error).message}\n  Remove it by hand: docker rm -f ${containerName}`,
      );
    }
    throw err;
  }
}

function parseMappedPort(dockerComposePortOutput: string): number {
  // `docker compose port <service> <containerPort>` prints "<host>:<port>", e.g. "0.0.0.0:54321".
  const match = dockerComposePortOutput.trim().match(/:(\d+)\s*$/);
  if (!match) {
    throw new Error(
      `postgres.ts: could not parse a host port out of \`docker compose port\` output: ${JSON.stringify(dockerComposePortOutput)}`,
    );
  }
  return Number(match[1]);
}

/**
 * Tears down this run's compose project, including its volumes (there is nothing else to keep).
 *
 * `E2E_PG_CONTAINER` has to be in the environment here as well as on `up`: compose VALIDATES the
 * whole file before it acts, and `container_name: ${E2E_PG_CONTAINER}` resolving to an empty string
 * fails that validation — so a `down` without it does not tear anything down, it errors out and
 * leaves the container running.
 */
export async function down(
  instance: Pick<DisposablePostgres, "projectName" | "containerName">,
): Promise<void> {
  await execFileAsync("docker", composeArgs(instance.projectName, ["down", "-v"]), {
    env: { ...process.env, E2E_PG_CONTAINER: instance.containerName },
  });
}

/**
 * Hard refusal, run before `migrate()`/role setup and before any write: this suite must never be
 * able to point at a database it did not create for THIS run. Three independent checks, any one
 * of which fails closed:
 *
 *   - host must be `127.0.0.1` — never a remote host, never a bare hostname that could resolve
 *     to one;
 *   - port must not be one of the KNOWN non-disposable-to-this-suite ports (see FORBIDDEN_PORTS);
 *   - the container name must be scoped to the run id this call is being made for — a stale env
 *     var or a copy-pasted URL from a different run cannot silently pass.
 *
 * Throws (never returns false) — the caller is expected to let this abort the run.
 */
export function assertDisposable(url: string, ctx: { runId: string; containerName: string }): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`assertDisposable: "${url}" is not a valid connection URL.`);
  }

  if (parsed.hostname !== "127.0.0.1") {
    throw new Error(
      `assertDisposable: refusing host "${parsed.hostname}" — the disposable E2E database must be 127.0.0.1 only.`,
    );
  }

  const port = Number(parsed.port);
  if (!port || FORBIDDEN_PORTS.has(port)) {
    throw new Error(
      `assertDisposable: refusing port ${parsed.port || "(none)"} — it is either unparseable or reserved for a known non-disposable-to-this-suite database (5432 dev, 5433/5434 reserved, 5439 the API's own throwaway compose). The E2E database must bind a dynamic port.`,
    );
  }

  assertSafeRunId(ctx.runId);
  if (!ctx.containerName.includes(ctx.runId) || !ctx.containerName.startsWith("rfphub-e2e-pg-")) {
    throw new Error(
      `assertDisposable: container "${ctx.containerName}" is not scoped to run "${ctx.runId}" — refusing to treat it as this run's disposable database.`,
    );
  }
}

/**
 * Creates (idempotently) the restricted runtime role the API processes run on, and applies the
 * real deploy artifacts `harden-audit.sql` AND `grant-auth.sql` against it — the SAME files a
 * real deployment runs, not a hand-copied approximation. Order matters and mirrors that file's own
 * documented sequence: the blanket CRUD grant happens first, then harden-audit.sql's targeted
 * `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log` narrows it. Reversing the order would leave a
 * window, however short, where the role could rewrite audit history.
 *
 * The role name is run-scoped and this function is safe to call more than once for the same run
 * (CREATE ROLE is guarded by an existence check; the grants are all idempotent GRANTs).
 */
export async function createRestrictedRole(
  target: Pick<DisposablePostgres, "runId" | "projectName" | "adminUrl">,
): Promise<RestrictedRole> {
  assertSafeRunId(target.runId);
  const role = `rfphub_e2e_${target.runId.toLowerCase().replace(/-/g, "_")}`;
  const password = randomBytes(24).toString("base64url");

  const admin = new pg.Pool({ connectionString: target.adminUrl });
  try {
    await admin.query(
      `DO $$
       BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
           EXECUTE format('CREATE ROLE %I LOGIN', '${role}');
         END IF;
       END $$;`,
    );
    await admin.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);
    await admin.query(`GRANT CONNECT ON DATABASE rfphub TO "${role}"`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`,
    );
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);

    // ── and then TAKE THE AUTH TABLES BACK ────────────────────────────────────────────────────
    //
    // The blanket grant above is a convenience this harness allows itself for the product's own
    // tables. Applied to the session library's four, it would be actively harmful: it would make
    // every login work in E2E for a reason that does not exist in production, where the runtime role
    // is granted table by table and nothing is blanket-granted at all.
    //
    // `grant-auth.sql` is the deploy artifact that grants them, and it is the single most likely
    // production-only failure of this whole adoption — the schema is perfectly correct, every test
    // against an owner connection passes, and every real login fails on `SELECT` over `auth_session`.
    // Revoking here is what makes this suite able to catch that: if the artifact is missing, wrong,
    // or applied in the wrong order, sign-in fails HERE, on the first identity the run creates.
    for (const table of AUTH_TABLES) {
      await admin.query(`REVOKE ALL ON TABLE ${table} FROM "${role}"`);
    }
  } finally {
    await admin.end();
  }

  // Order matters and mirrors the runbook: migrations first (the caller has already run them, which
  // is why these tables exist to be granted on), then the two artifacts.
  await runSqlArtifact(target.projectName, role, hardenAuditSqlPath, "harden-audit.sql");
  await runSqlArtifact(target.projectName, role, grantAuthSqlPath, "grant-auth.sql");

  const runtimeUrl = `postgres://${role}:${password}@127.0.0.1:${new URL(target.adminUrl).port}/rfphub`;
  return { role, password, runtimeUrl };
}

/**
 * Pipes the real `harden-audit.sql` artifact through `psql` inside the compose-managed container,
 * exactly as a real deployment is documented to run it (see that file's own header comment), with
 * `role` bound as a psql variable so the file's `:"role"`/`:'role'` substitutions resolve to this
 * run's restricted role rather than a hard-coded name.
 */
async function runSqlArtifact(
  projectName: string,
  role: string,
  path: string,
  label: string,
): Promise<void> {
  const sql = readFileSync(path, "utf8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      composeArgs(projectName, [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "rfphub",
        "-d",
        "rfphub",
        "-v",
        `role=${role}`,
        "-f",
        "-",
      ]),
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`postgres.ts: ${label} exited ${code} against role "${role}":\n${stderr}`),
        );
      }
    });

    child.stdin?.end(sql);
  });
}
