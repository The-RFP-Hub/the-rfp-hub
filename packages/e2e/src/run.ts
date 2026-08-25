/**
 * The external runner: the single owner of every out-of-process resource this suite creates.
 *
 * WHY PLAYWRIGHT IS A CHILD RATHER THAN THE OWNER. Playwright's `globalTeardown` and `webServer`
 * both run inside the Playwright process, and that process can be killed. A Docker container, a
 * detached `next dev` tree and a temp directory holding session material are not things to leave to
 * a hook that may not run. So the lifecycle lives here, in one `try/finally`, and Playwright is
 * spawned in the middle of it. An interrupt sets a flag and kills the Playwright child; the async
 * cleanup happens where async cleanup can actually be awaited — in `finally`.
 *
 * BRING-UP ORDER, AND WHY IT IS THIS ORDER:
 *
 *   1. temp dir, secret registry, `.next` lock, run id — everything downstream is named after it
 *   2. Postgres (run-scoped), prove disposable, migrate from empty as the OWNER, create the
 *      RESTRICTED runtime role and apply the real `harden-audit.sql`
 *   3. the fixture web server — the "external site" verification fetches
 *   4. the identity preflight — talks to the identity provider, and to nothing of ours: the very
 *      first `/v1/me` a fresh identity sends is itself an M3 criterion, and a preflight that
 *      "checked the token works" would consume the only chance to observe it
 *   5. the frontend, which does not need the API to boot
 *   6. at the browser-only level ONLY: a throwaway browser login, to learn the identity's DID
 *      BEFORE the API starts — otherwise bootstrapping an administrator would be circular
 *   7. the API, on the restricted role
 *   8. warm the routes a spec will navigate, so a per-test timeout is not a first-compile timeout
 *   9. write the state file (identifiers and configuration; no token, ever)
 *  10. run Playwright
 *  11. `finally`: artifact scan → children (whole process groups) → `compose down -v` → temp dir →
 *      lock
 *
 * Everything the run creates is named `…-<runId>`, so a second run on the same machine shares
 * nothing with it and `down -v` can never reach past its own project.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type GrantAdminResult, ceremonyLogFile, grantAdmin } from "./admin-ceremony.js";
import {
  apiDir,
  apiEnv,
  frontendDir,
  frontendEnv,
  migrateEnv,
  newAuthSecret,
  playwrightEnv,
  repoRoot,
} from "./env.js";
import * as fixtureServer from "./fixture-server.js";
import { isHealthy } from "./http.js";
import { assignActors, establishIdentities, namespacesFor } from "./identity/actors.js";
import { login } from "./identity/browser-login.js";
import { describe as describePreflight, preflight } from "./identity/preflight.js";
import {
  API_URL_ENV,
  AUTH_SECRET_ENV,
  IDENTITIES_ENV,
  type Identity,
  OUTBOX_ENV,
} from "./identity/sessions.js";
import * as orphans from "./orphans.js";
import * as ports from "./ports.js";
import * as postgres from "./postgres.js";
import * as processes from "./processes.js";
import { initRegistry, redact, register } from "./redact.js";
import { describeScan, scan } from "./scan-artifacts.js";
import { type RunState, writeState } from "./state.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Context {
  runId: string;
  tmp: string;
  children: processes.ManagedChild[];
  pg?: postgres.DisposablePostgres;
  fixture?: fixtureServer.FixtureServer;
  lockPath?: string;
  lockFd?: number;
  interrupted: boolean;
  /** `<runId>:<nonce>` — what the workspace's ownership marker must contain to be removable. */
  ownershipToken: string;
  statePath: string;
  secretsPath: string;
  identitiesPath: string;
  /** Where workers record processes THEY started, so this runner can still reap them. */
  orphanRegisterPath: string;
  /**
   * Where the API writes sign-in codes.
   *
   * INSIDE the run's own 0700 directory, never a shared or OS temp location: it holds live codes,
   * and it is removed by `finally` on every path including SIGINT.
   */
  outboxDir: string;
  logDir: string;
}

/**
 * The name of the marker file that says "this directory belongs to an E2E run and may be removed".
 *
 * Teardown does `rm -rf` on the run's working directory, and that is a dangerous thing to do to a
 * path an operator supplied. The marker is written by the run that created the directory and is
 * VERIFIED before the removal — so a directory this suite did not create is never deleted, however
 * it came to be named.
 */
const OWNERSHIP_MARKER = ".rfphub-e2e-owned";

/**
 * The minimum Node this suite can run on, checked before anything is started.
 *
 * The repository as a whole supports Node 18 and that is not changed here — the API and the
 * libraries genuinely run there. Playwright 1.62 does not: it refuses to start on anything below
 * Node 20. Without this check that shows up as a confusing failure from deep inside a child process
 * AFTER a Postgres container, an API and a frontend have already been started, and the operator has
 * to work backwards to a version requirement nothing stated. `packages/e2e/package.json` declares
 * `engines.node >= 20` for the same reason; this is the part that produces a readable message.
 */
const MINIMUM_NODE_MAJOR = 20;

function assertSupportedNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `this suite needs Node ${MINIMUM_NODE_MAJOR} or newer (running ${process.versions.node}). Playwright refuses to start on older versions. The rest of the repository still supports Node 18; only packages/e2e requires ${MINIMUM_NODE_MAJOR}+.`,
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const runId = (process.env.E2E_RUN_ID ?? randomBytes(4).toString("hex")).toLowerCase();

  // `E2E_TMP` names a PARENT to work under, never the working directory itself.
  //
  // The run's directory is always a fresh run-scoped child of it. Treating the variable as the
  // working directory meant that pointing it at anything real — a shared scratch folder, a
  // workspace, `$HOME/tmp` — ended with teardown recursively deleting that directory and everything
  // else in it. A caller who sets an environment variable is asking where to put things, not
  // volunteering the contents of that place.
  const tmpRoot = process.env.E2E_TMP ?? tmpdir();
  const tmp = join(tmpRoot, `rfphub-e2e-${runId}`);

  const ctx: Context = {
    runId,
    tmp,
    children: [],
    interrupted: false,
    ownershipToken: `${runId}:${randomUUID()}`,
    statePath: join(tmp, "state.json"),
    secretsPath: join(tmp, "secrets"),
    identitiesPath: join(tmp, "identities.json"),
    orphanRegisterPath: join(tmp, "child-pids"),
    outboxDir: join(tmp, "outbox"),
    logDir: join(tmp, "logs"),
  };

  // Interrupts set a flag and stop whatever is currently in the foreground. They deliberately do
  // NOT clean up: cleanup is async, `finally` is where async cleanup can be awaited, and an exit
  // handler that started a promise would be racing the process's own exit.
  let foreground: processes.ManagedChild | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (ctx.interrupted) return; // A second Ctrl-C: let the default behaviour take over.
    ctx.interrupted = true;
    process.stderr.write(`\n${signal} received — stopping the run and tearing down.\n`);
    if (foreground) void processes.stop(foreground);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // The handle an interrupt needs to reach. Set through a named function rather than inline, so the
  // one place `foreground` changes is greppable — an interrupt that killed the wrong child, or none,
  // would be a teardown bug that only shows up on a Ctrl-C nobody tests twice.
  const setForeground = (child: processes.ManagedChild): void => {
    foreground = child;
  };

  let code = 0;
  try {
    const state = await bringUp(ctx);

    if (ctx.interrupted) return 130;

    if (argv.includes("--check-m3")) {
      const { runCheckM3 } = await import("./run-check-m3.js");
      code = await runCheckM3({ state, tmp: ctx.tmp, onChild: setForeground });
    } else {
      code = await runPlaywright(ctx, argv, setForeground);
    }
  } catch (err) {
    if (processes.isInterrupted(err)) {
      // Not a failure: the operator asked the run to stop. Teardown below is identical either way.
      process.stderr.write("Run stopped before it finished. Tearing down.\n");
      code = 130;
    } else {
      process.stderr.write(
        `\nE2E run failed during bring-up:\n${redact(String((err as Error).stack ?? err))}\n`,
      );
      code = 2;
    }
  } finally {
    foreground = undefined;
    const teardownProblems = await tearDown(ctx);
    if (teardownProblems.length > 0) {
      process.stderr.write(
        `\nTeardown problems:\n${teardownProblems.map((p) => `  • ${p}`).join("\n")}\n`,
      );
      code ||= 1;
    }
  }

  return ctx.interrupted ? 130 : code;
}

// ── bring-up ───────────────────────────────────────────────────────────────────────────────────

/**
 * Abandons bring-up at the next step boundary once an interrupt has been recorded.
 *
 * Bring-up is a sequence of expensive steps, and without a check between them a Ctrl-C during the
 * first one would be honoured only after the last one finished — which, with a cold `next dev`
 * compile in the middle, is a minute or more of a run the operator has already asked to stop. The
 * throw lands in `main`'s `catch`, which recognises it as an interrupt rather than a failure, and
 * `finally` tears down exactly as it would have anyway.
 */
function abortIfInterrupted(ctx: Context): void {
  if (ctx.interrupted) throw new processes.InterruptedError("interrupted during bring-up");
}

async function bringUp(ctx: Context): Promise<RunState> {
  // The PARENT may legitimately need creating; the run's OWN directory must not already exist.
  //
  // `E2E_RUN_ID` can be reused deliberately (it is the documented way to re-run against a
  // part-provisioned stack), and two invocations reusing it used to accept the same directory and
  // the same marker. The second would then typically fail on the frontend lock — and delete the
  // FIRST one's live workspace on its way out, taking that run's session state with it. Creating
  // non-recursively makes the collision an immediate, explicit refusal instead.
  mkdirSync(dirname(ctx.tmp), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(ctx.tmp, { recursive: false, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `${ctx.tmp} already exists. Another run is using this E2E_RUN_ID, or a previous one left it behind (E2E_KEEP_TMP, or a crash). Use a different E2E_RUN_ID, or remove that directory.`,
      );
    }
    throw err;
  }

  // The marker carries a nonce as well as the run id, so that even two runs that somehow reached
  // the same path cannot each recognise the other's directory as their own. It is written before
  // anything else goes in, and re-read before the directory is removed.
  writeFileSync(join(ctx.tmp, OWNERSHIP_MARKER), `${ctx.ownershipToken}\n`, { mode: 0o600 });
  mkdirSync(ctx.logDir, { recursive: true, mode: 0o700 });
  initRegistry(ctx.secretsPath);

  process.stdout.write(`run ${ctx.runId} · workspace ${ctx.tmp}\n`);

  acquireNextLock(ctx);

  // ── 2. the disposable database, its two roles, and the schema ────────────────────────────────
  process.stdout.write("• starting the disposable Postgres…\n");
  abortIfInterrupted(ctx);
  ctx.pg = await postgres.up(ctx.runId);
  process.stdout.write(
    `  Postgres on 127.0.0.1:${ctx.pg.port} (container ${ctx.pg.containerName})\n`,
  );

  process.stdout.write("• migrating from empty (owner role)…\n");
  const migration = await processes.run({
    name: "migrate",
    command: "pnpm",
    args: ["--filter", "@the-rfp-hub/api", "migrate"],
    cwd: repoRoot,
    env: migrateEnv(ctx.pg.adminUrl),
  });
  if (migration.code !== 0) {
    throw new Error(`migrate exited ${migration.code}:\n${migration.output}`);
  }

  process.stdout.write("• creating the restricted runtime role and applying harden-audit.sql…\n");
  abortIfInterrupted(ctx);
  const restricted = await postgres.createRestrictedRole(ctx.pg);
  register(restricted.password, { label: "runtime-db-password", longLived: false });
  process.stdout.write(
    `  runtime role ${restricted.role} (least privilege — the API runs on this)\n`,
  );

  // ── 3. the fixture web server ────────────────────────────────────────────────────────────────
  abortIfInterrupted(ctx);
  ctx.fixture = await fixtureServer.start({ runId: ctx.runId });
  const fixtureUrl = `http://127.0.0.1:${ctx.fixture.port}`;
  process.stdout.write(`• fixture web server on ${fixtureUrl}\n`);

  // ── 4. what, if anything, is optional ────────────────────────────────────────────────────────
  //
  // Almost nothing, now. The identity provider is the API itself and sign-in codes go to a file
  // inside this run's own directory, so email sign-in needs no configuration at all — no tenant, no
  // secret, no acknowledgement, no ceiling on identities. The only optional lane is the local OIDC
  // stub. There is no ladder any more and nothing here can degrade the run.
  abortIfInterrupted(ctx);
  const identity = preflight();
  process.stdout.write(`• ${describePreflight(identity)}\n`);
  for (const note of identity.notes) process.stdout.write(`  – ${note}\n`);

  // The rotation parameter. Deterministic, and recorded in the run state so a run is reproducible.
  const actorSeed = Number.parseInt(process.env.E2E_ACTOR_SEED ?? "0", 10) || 0;
  const namespaces = namespacesFor(ctx.runId, actorSeed);
  // Signs this run's sessions and nothing else's. Generated here, thrown away with the run.
  const authSecret = newAuthSecret();

  // ── 5. the frontend ──────────────────────────────────────────────────────────────────────────
  const taken = new Set<number>([ctx.pg.port]);
  const apiPort = await ports.reserve(taken);
  const frontendPort = await ports.reserve(taken);

  const frontend = processes.start({
    name: "frontend",
    command: "pnpm",
    // `--webpack` is NOT optional here. Turbopack is Next 16's default, and the frontend's
    // `next.config.ts` carries a `webpack()` hook — the `@farcaster/mini-app-solana: false` alias
    // that keeps an uninstalled optional peer from failing resolution. Under Turbopack that hook is
    // ignored (and a build refuses outright), so the dev server this suite drives has to be the same
    // bundler the package's own `dev` script uses.
    args: [
      "exec",
      "next",
      "dev",
      "--webpack",
      "--port",
      String(frontendPort),
      "--hostname",
      "127.0.0.1",
    ],
    cwd: frontendDir,
    env: frontendEnv({ apiPort }),
    logFile: join(ctx.logDir, "frontend.log"),
  });
  ctx.children.push(frontend);
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  process.stdout.write(`• frontend starting on ${frontendUrl}…\n`);
  abortIfInterrupted(ctx);
  await processes.waitFor({
    what: "frontend",
    abort: () => ctx.interrupted,
    watch: frontend,
    timeoutMs: 120_000,
    probe: async () =>
      (await fetch(frontendUrl, { redirect: "manual" }).catch(() => undefined))?.status !==
      undefined,
  });

  // ── 6. the API, on the restricted role ───────────────────────────────────────────────────────
  const analyticsHmacKey = randomBytes(32).toString("hex");
  register(analyticsHmacKey, { label: "analytics-hmac-key", longLived: false });

  const api = processes.start({
    name: "api",
    command: "pnpm",
    args: ["exec", "tsx", "src/server.ts"],
    cwd: apiDir,
    env: apiEnv({
      databaseUrl: restricted.runtimeUrl,
      port: apiPort,
      authSecret,
      outboxDir: ctx.outboxDir,
      frontendOrigin: frontendUrl,
      analyticsHmacKey,
      allowPrivateHosts: true,
    }),
    logFile: join(ctx.logDir, "api.log"),
  });
  ctx.children.push(api);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  process.stdout.write(`• API starting on ${apiUrl} (restricted role)…\n`);
  abortIfInterrupted(ctx);
  await processes.waitFor({
    what: "API /v1/health",
    abort: () => ctx.interrupted,
    watch: api,
    timeoutMs: 90_000,
    probe: () => isHealthy(apiUrl),
  });

  // ── 7. identities, the administrator, and the browser session ────────────────────────────────
  //
  // ALL OF THIS IS NOW POSSIBLE OFFLINE, and the order is the interesting part.
  //
  // Signing in creates the `auth_user` row and nothing else — the product's `accounts` row is
  // created just-in-time on the first `/v1/me`, which is itself an M3 criterion. So bring-up
  // deliberately signs in and then does NOT call `/v1/me`, leaving that first request for the
  // acceptance setup to observe.
  // This process signs in too, so it needs the same two pointers the workers get.
  process.env[API_URL_ENV] = apiUrl;
  process.env[OUTBOX_ENV] = ctx.outboxDir;
  process.env[AUTH_SECRET_ENV] = authSecret;

  process.stdout.write("• signing in as this run's identities…\n");
  abortIfInterrupted(ctx);
  const identities = await establishIdentities(ctx.runId);
  const assignment = assignActors(identities, namespaces);
  process.stdout.write(`  ${identities.length} identities established, offline\n`);

  // The administrator is GRANTED, never configured: the API promotes nobody from its environment.
  // Run after the sign-ins so the ceremony promotes an identity that already exists — which is also
  // the shape an operator's first grant takes against a real deployment.
  const adminActor = assignment.actors.admin;
  if (!adminActor) throw new Error("run: no administrator identity was established");
  const adminCeremony = await grantAdmin({
    email: adminActor.email,
    adminDatabaseUrl: ctx.pg.adminUrl,
    logFile: ceremonyLogFile(ctx.logDir, "bringup"),
  });
  process.stdout.write(`• admin ceremony: ${adminCeremony.outcome} for the run's administrator\n`);

  // The browser signs in as the PUBLISHER, through the frontend's own form. `storageState` belongs
  // to exactly one identity, and the owner-only dashboard specs read entries that actor created.
  const publisherActor = assignment.actors.publisher;
  if (!publisherActor) throw new Error("run: no publisher identity was established");
  process.stdout.write("• signing in through the frontend…\n");
  abortIfInterrupted(ctx);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  let browserSession: Awaited<ReturnType<typeof login>>;
  try {
    browserSession = await login({
      browser,
      frontendUrl,
      apiUrl,
      email: publisherActor.email,
      outboxDir: ctx.outboxDir,
      storageStatePath: join(ctx.tmp, "auth", "storage-state.json"),
      failureScreenshotPath: join(ctx.logDir, "browser-login-failure.png"),
      consoleLogPath: join(ctx.logDir, "browser-console.log"),
    });
  } finally {
    await browser.close();
  }
  process.stdout.write("  signed in; session state captured\n");

  // ── 8. warm the frontend routes ──────────────────────────────────────────────────────────────
  // `next dev` compiles per route on first request. A 20-second expect timeout inside a spec is
  // there for the analytics buffer, not for webpack, so the compile happens here instead.
  abortIfInterrupted(ctx);
  process.stdout.write("• warming frontend routes…\n");
  for (const route of [
    "/",
    "/dashboard",
    "/listings",
    "/keys",
    "/review",
    "/admin",
    "/duplicates",
    "/account",
    // A dynamic segment compiles once, per route rather than per id, so any id warms it. This one
    // cannot exist, which is the point: the compile is what is wanted, not the data.
    "/opportunities/warm-up",
  ]) {
    await fetch(`${frontendUrl}${route}`, { redirect: "manual" }).catch(() => undefined);
  }

  // ── 9. the state file ────────────────────────────────────────────────────────────────────────
  const state: RunState = {
    runId: ctx.runId,
    startedAt: new Date().toISOString(),
    blocked: assignment.blocked,
    conditional: assignment.conditional,
    ports: {
      api: apiPort,
      frontend: frontendPort,
      fixture: ctx.fixture.port,
      postgres: ctx.pg.port,
    },
    urls: {
      api: apiUrl,
      frontend: frontendUrl,
      fixture: fixtureUrl,
      programme: `${fixtureUrl}/programme/${ctx.runId}`,
    },
    db: {
      adminUrl: ctx.pg.adminUrl,
      runtimeUrl: restricted.runtimeUrl,
      runtimeRole: restricted.role,
    },
    namespaces: { publisher: namespaces.publisher, other: namespaces.other },
    actors: assignment.actors,
    adminCeremony: adminCeremony.outcome,
    actorSeed,
    permutation: Object.fromEntries(
      Object.entries(assignment.actors).map(([name, actor]) => [name, actor.userId]),
    ),
    previousAdminEmail: previousAdmin(assignment.actors.admin?.userId),
    outboxDir: ctx.outboxDir,
    logs: { api: api.logFile, frontend: frontend.logFile },
    storageStatePath: browserSession.storageStatePath,
    browserUserId: browserSession.userId,
  };

  recordAssignment(state);
  writeState(ctx.statePath, state);
  writeIdentities(ctx, identities);

  process.stdout.write("• stack ready · email sign-in, offline, no external configuration\n");
  return state;
}

/**
 * The identities this run established, for the Playwright workers.
 *
 * SEPARATE FROM `state.json`, and now for a smaller reason than before. That file is identifiers and
 * configuration and can be printed into a report without a second thought; this one carries session
 * tokens, so it stays in the run's 0700 directory at mode 0600 and goes away with it.
 *
 * A worker that finds an identity here uses its token directly; one that does not can simply sign in
 * again, because signing in needs nothing but an address and the outbox. That fallback did not exist
 * when tokens came from a rate-limited tenant.
 */
/**
 * The cross-run assignment record: who was the administrator last time.
 *
 * WHAT IT CAN STILL PROVE HAS NARROWED, and honestly so. When identities lived in an external tenant
 * that outlived every run, comparing two runs proved something real: an identity that had been an
 * administrator came back with nothing, because the tenant remembered the identity while the
 * database did not. The identity store is now this run's OWN disposable database, destroyed with its
 * container — so the comparison no longer spans two stores.
 *
 * It is kept because the weaker claim is still worth pinning: a fresh database grants nothing. No
 * role survives a run, the rotation really does move the administrator between addresses, and the
 * ceremony is the only thing that creates one. The assertion in `00-acceptance.setup.ts` is worded
 * to say exactly that and no more.
 *
 * The record lives wherever `E2E_ASSIGNMENT_RECORD` points — an explicit opt-in path outside the
 * repository. Absent the variable, nothing is written and nothing is asserted.
 */
function previousAdmin(currentAdminUserId: string | undefined): string | undefined {
  const path = process.env.E2E_ASSIGNMENT_RECORD;
  if (!path) return undefined;
  try {
    const previous = JSON.parse(readFileSync(path, "utf8")) as { adminEmail?: string };
    void currentAdminUserId;
    return previous.adminEmail;
  } catch {
    return undefined; // No record yet — the first run of a pair. Not an error.
  }
}

function recordAssignment(state: RunState): void {
  const path = process.env.E2E_ASSIGNMENT_RECORD;
  if (!path) return;
  const record = {
    runId: state.runId,
    actorSeed: state.actorSeed,
    adminEmail: state.actors.admin?.email,
    adminUserId: state.actors.admin?.userId,
    permutation: state.permutation,
    at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function writeIdentities(ctx: Context, identities: Identity[]): void {
  writeFileSync(ctx.identitiesPath, `${JSON.stringify(identities, null, 2)}\n`, { mode: 0o600 });
}

/**
 * An exclusive lock on the frontend's dev cache.
 *
 * `next dev` keeps a per-directory build cache and its own lock inside `.next/`. Two concurrent E2E
 * runs would share it and corrupt each other's compile state in ways that surface as unrelated,
 * unreproducible spec failures. Refusing the second run with a clear message is strictly better
 * than supporting a configuration that cannot work.
 */
function acquireNextLock(ctx: Context): void {
  // BESIDE `.next/`, not inside it. `next dev` clears and recreates parts of that directory on
  // start, which silently deleted a lock file kept there — and a lock that a lock-protected process
  // deletes on its way up is not a lock at all. This location is the frontend package directory,
  // which nothing else rewrites.
  const lockPath = join(frontendDir, ".e2e-next-lock");
  try {
    // "wx" — create exclusively. The failure mode IS the feature.
    ctx.lockFd = openSync(lockPath, "wx");
    writeFileSync(ctx.lockFd, `${ctx.runId} ${process.pid} ${new Date().toISOString()}\n`);
    ctx.lockPath = lockPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `another E2E run holds ${lockPath}. \`next dev\` shares one build cache per directory, so two runs cannot proceed at once. Wait for the other run, or remove that file if it is stale.`,
      );
    }
    throw err;
  }
}

// ── running the suite ──────────────────────────────────────────────────────────────────────────

async function runPlaywright(
  ctx: Context,
  argv: string[],
  onChild: (child: processes.ManagedChild) => void,
): Promise<number> {
  const passthrough = argv.filter((arg) => arg !== "--check-m3");
  const env = playwrightEnv({
    stateFile: ctx.statePath,
    secretsFile: ctx.secretsPath,
    tmpDir: ctx.tmp,
  });
  // What a worker needs in order to sign in on its own: where the API is, and where its codes land.
  // There is no secret in this list. The previous harness had to forward a tenant's app secret so
  // workers could mint tokens; that hazard is gone with the tenant.
  env[IDENTITIES_ENV] = ctx.identitiesPath;
  env[API_URL_ENV] = process.env[API_URL_ENV] ?? "";
  env[OUTBOX_ENV] = ctx.outboxDir;
  env[AUTH_SECRET_ENV] = process.env[AUTH_SECRET_ENV] ?? "";
  // A worker that starts its own process records it here, so this runner can reap it even if the
  // worker never reaches its own cleanup. See `orphans.ts`.
  env[orphans.ORPHAN_REGISTER_ENV] = ctx.orphanRegisterPath;

  process.stdout.write("• running Playwright…\n\n");
  const result = await processes.run(
    {
      name: "playwright",
      command: "pnpm",
      args: ["exec", "playwright", "test", ...passthrough],
      cwd: packageDir,
      env,
      inheritStdio: true,
    },
    onChild,
  );
  return result.code ?? 1;
}

// ── teardown ───────────────────────────────────────────────────────────────────────────────────

/**
 * Runs unconditionally, including after a throw and after an interrupt.
 *
 * Order matters: the artifact scan reads what Playwright wrote and must happen while the files are
 * still there; the children go next so nothing is holding a database connection when the container
 * is destroyed; the temp directory (which holds `storageState` and the secret registry) goes last,
 * because the scan needs the registry.
 */
async function tearDown(ctx: Context): Promise<string[]> {
  const problems: string[] = [];

  // 1. the artifact scan — after Playwright has exited, which is the only time a trace zip is
  //    finalised and therefore the only time it can be read.
  try {
    const result = scan([join(packageDir, "test-results"), join(packageDir, "playwright-report")]);
    process.stdout.write(`\n${describeScan(result)}\n`);
    if (result.unreadable.length > 0) {
      // An artifact the scan could not read is NOT a clean artifact: the trace most likely to
      // carry a secret is exactly the one most likely to be malformed. Failing loudly here is the
      // difference between "scanned and clean" and "did not look".
      for (const entry of result.unreadable) {
        process.stderr.write(`  ✗ not scanned: ${entry}\n`);
      }
      problems.push(
        `${result.unreadable.length} artifact(s) could not be scanned — an unscanned artifact is not a clean one`,
      );
    }
    if (result.hits.length > 0) {
      for (const hit of result.hits) {
        process.stderr.write(
          `  ✗ ${hit.label} found in ${hit.file}${hit.member ? ` › ${hit.member}` : ""}\n`,
        );
      }
      problems.push(
        `${result.hits.length} long-lived secret(s) found in run artifacts — a security defect`,
      );
    }
  } catch (err) {
    problems.push(`artifact scan: ${(err as Error).message}`);
  }

  // 2. children, as whole process groups.
  problems.push(...(await processes.stopAll(ctx.children)));
  // The liveness check is POLLED rather than taken once. `stop()` waits for the direct child to
  // exit, but a killed group's grandchildren are reparented and reaped a moment later, so an
  // immediate `kill(-pgid, 0)` can still find the group and report a leak that was only a race.
  // Polling makes a reported leak a real one — which is the claim the run's teardown proof makes.
  for (const child of ctx.children) {
    if (await processes.waitUntilGone(child.pid, 5_000)) continue;
    problems.push(`${child.name} (pid ${child.pid}) is still alive after SIGKILL`);
  }

  // Anything a Playwright worker started on its own. Normally already gone — the spec that started
  // it stops it — but a worker that was killed before its cleanup ran would otherwise leave a live
  // server behind, holding a port and a database connection, that nothing in this run knows about.
  for (const child of orphans.registered(ctx.orphanRegisterPath)) {
    if (!processes.alive(child.pid)) continue;
    process.stdout.write(`• reaping a worker-started process: ${child.what} (pid ${child.pid})\n`);
    await processes.stopGroup(child.pid);
    if (!(await processes.waitUntilGone(child.pid, 5_000))) {
      problems.push(`${child.what} (pid ${child.pid}), started by a worker, survived SIGKILL`);
    }
  }

  // 3. the fixture server, which is in-process.
  if (ctx.fixture) {
    try {
      await ctx.fixture.stop();
    } catch (err) {
      problems.push(`fixture server: ${(err as Error).message}`);
    }
  }

  // 4. the container and its volume. `down -v` reaches only this run's compose project.
  if (ctx.pg) {
    try {
      await postgres.down(ctx.pg);
      process.stdout.write(`• removed compose project ${ctx.pg.projectName}\n`);
    } catch (err) {
      problems.push(`docker compose down -v: ${(err as Error).message}`);
    }
  }

  // 5. the lock.
  if (ctx.lockFd !== undefined) {
    try {
      closeSync(ctx.lockFd);
    } catch {
      // Already closed. Not a problem; the unlink below is what matters.
    }
  }
  if (ctx.lockPath) {
    try {
      unlinkSync(ctx.lockPath);
    } catch (err) {
      problems.push(`releasing the frontend lock: ${(err as Error).message}`);
    }
  }

  // 6. the temp directory — `storageState`, the secret registry, the identity map and the child
  //    logs. Kept when E2E_KEEP_TMP is set, which is the debugging escape hatch, announced loudly
  //    because it leaves session material on disk.
  if (process.env.E2E_KEEP_TMP) {
    process.stdout.write(
      `• E2E_KEEP_TMP is set — leaving ${ctx.tmp} in place (it contains session material)\n`,
    );
  } else {
    try {
      // The marker is re-read rather than assumed. If it is absent or names a different run, this
      // is not the directory this run created and it is left strictly alone — a recursive delete of
      // somebody else's data is far worse than a leftover temp directory, so the failure mode here
      // is deliberately "leak and say so".
      const owner = readFileSync(join(ctx.tmp, OWNERSHIP_MARKER), "utf8").trim();
      if (owner !== ctx.ownershipToken) {
        problems.push(
          `refusing to remove ${ctx.tmp}: its ownership marker does not match this run's token`,
        );
      } else {
        rmSync(ctx.tmp, { recursive: true, force: true });
      }
    } catch (err) {
      problems.push(
        `refusing to remove ${ctx.tmp} (no readable ownership marker): ${(err as Error).message}`,
      );
    }
  }

  return problems;
}

// A unique marker in the process title makes a leftover trivially findable in `ps` — which is how
// the teardown claim in the report is checked rather than asserted.
process.title = `rfphub-e2e-runner-${randomUUID().slice(0, 8)}`;

// Checked before `main`, so an unsupported runtime is a single readable line rather than a stack
// trace out of a child process that started after a container and two servers were already up.
try {
  assertSupportedNode();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(2);
}

process.exitCode = await main(process.argv.slice(2));
