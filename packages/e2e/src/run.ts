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
 *   5. the dashboard, which does not need the API to boot
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
import { exportSPKI, generateKeyPair } from "jose";
import { type GrantAdminResult, ceremonyLogFile, grantAdmin } from "./admin-ceremony.js";
import {
  apiDir,
  apiEnv,
  dashboardDir,
  dashboardEnv,
  migrateEnv,
  playwrightEnv,
  repoRoot,
} from "./env.js";
import * as fixtureServer from "./fixture-server.js";
import { isHealthy } from "./http.js";
import * as orphans from "./orphans.js";
import * as ports from "./ports.js";
import * as postgres from "./postgres.js";
import { assignActors, namespacesFor } from "./privy/identities.js";
import {
  type PreflightResult,
  describe as describePreflight,
  preflight,
} from "./privy/preflight.js";
import * as processes from "./processes.js";
import { initRegistry, redact, register } from "./redact.js";
import { describeScan, scan } from "./scan-artifacts.js";
import { type RunState, writeState } from "./state.js";
import { APP_ID_ENV, APP_SECRET_ENV, IDENTITIES_ENV, type IdentityRecord } from "./tokens.js";

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
 * AFTER a Postgres container, an API and a dashboard have already been started, and the operator has
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
  // the same marker. The second would then typically fail on the dashboard lock — and delete the
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

  // ── 4. the identity preflight ────────────────────────────────────────────────────────────────
  process.stdout.write("• identity preflight…\n");
  abortIfInterrupted(ctx);
  const identity = await preflight();
  process.stdout.write(`  ${describePreflight(identity)}\n`);
  for (const note of identity.notes) process.stdout.write(`  – ${note}\n`);
  for (const failure of identity.failures) {
    process.stdout.write(
      `  – mint failure [${failure.kind}] for ${failure.credential}: ${redact(failure.detail)}\n`,
    );
  }

  // The rotation parameter. Deterministic, and recorded in the run state so a run is reproducible.
  const actorSeed = Number.parseInt(process.env.E2E_ACTOR_SEED ?? "0", 10) || 0;
  const namespaces = namespacesFor(ctx.runId, actorSeed);
  // The browser's identity is passed in so it becomes the PUBLISHER — the actor whose entries the
  // owner-only dashboard specs read. Knowable here because the browser signs in with the same
  // address a token was already minted for.
  let assignment = assignActors(identity.identities, namespaces, identity.browserDid, actorSeed);

  // ── the API's identity configuration ─────────────────────────────────────────────────────────
  //
  // With no verification key configured anywhere, `PrivyTokenService` answers 503 `auth_unconfigured`
  // to every session-shaped credential — including the deliberately-bad ones. The whole
  // negative-authentication surface, which is the ONE thing the no-identity level is supposed to
  // still prove, would then fail on a machine that simply has no `.env`.
  //
  // So a key pair is generated and only its PUBLIC half is given to the API. The private half is
  // discarded here and never leaves this scope, so no valid token for it can exist anywhere — which
  // is precisely the configuration the negatives want: a real verification path, correctly
  // configured, that must reject everything presented to it.
  let appId = identity.credentials.appId;
  let verificationKey = identity.credentials.verificationKey;
  const inertVerificationKey = !verificationKey;
  if (inertVerificationKey) {
    const pair = await generateKeyPair("ES256", { extractable: true });
    verificationKey = await exportSPKI(pair.publicKey);
    appId = appId ?? `m3e2e-inert-${ctx.runId}`;
    process.stdout.write(
      "  no verification key is configured — booting with a locally generated one whose private\n" +
        "  half is discarded, so the negative-authentication assertions still execute. Nothing\n" +
        "  positive can be claimed from this configuration.\n",
    );
  }

  // ── 5. the dashboard ─────────────────────────────────────────────────────────────────────────
  const taken = new Set<number>([ctx.pg.port]);
  const apiPort = await ports.reserve(taken);
  const dashboardPort = await ports.reserve(taken);

  const dashboard = processes.start({
    name: "dashboard",
    command: "pnpm",
    // `--webpack` is NOT optional here. Turbopack is Next 16's default, and the dashboard's
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
      String(dashboardPort),
      "--hostname",
      "127.0.0.1",
    ],
    cwd: dashboardDir,
    env: dashboardEnv({ apiPort, appId }),
    logFile: join(ctx.logDir, "dashboard.log"),
  });
  ctx.children.push(dashboard);
  const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
  process.stdout.write(`• dashboard starting on ${dashboardUrl}…\n`);
  abortIfInterrupted(ctx);
  await processes.waitFor({
    what: "dashboard",
    abort: () => ctx.interrupted,
    watch: dashboard,
    timeoutMs: 120_000,
    probe: async () =>
      (await fetch(dashboardUrl, { redirect: "manual" }).catch(() => undefined))?.status !==
      undefined,
  });

  // ── 6. the browser session ───────────────────────────────────────────────────────────────────
  //
  // At the BROWSER-ONLY level this has to happen BEFORE the API starts, and that ordering resolves a
  // circularity: the administrator must be granted before the privileged surface is usable, the
  // ceremony needs a DID, and at that level the only source of a DID is a token from a browser
  // session. So the dashboard (which does not need the API to render its login) is brought up first,
  // a throwaway login learns the DID, and only then are the ceremony and the API run. At every other
  // level the DIDs came from the provider directly, so the login happens after the API and its own
  // `/v1/me` is part of what it proves.
  let browserSession: Awaited<ReturnType<typeof establishBrowserSession>>;
  if (identity.level === "L3-BROWSER-ONLY") {
    browserSession = await establishBrowserSession(ctx, {
      dashboardUrl,
      apiUrl: `http://127.0.0.1:${apiPort}`,
      awaitApiSession: false,
      tenantAcknowledged: identity.tenant.acknowledged,
    });
    if (browserSession) {
      // The harvested identity IS the run's identity at this level.
      assignment = assignActors(
        [
          {
            did: browserSession.did,
            via: "test-account-email",
            credential: "(browser session)",
            expiresAt: 0,
          },
        ],
        namespaces,
        browserSession.did,
        actorSeed,
      );
    }
  }

  // ── 7. the administrator, made by the operator ceremony ──────────────────────────────────────
  //
  // Not by the API's environment — it no longer promotes anyone. This runs after the rotation has
  // chosen the administrator (and, at the browser-only level, after the login that reveals the DID),
  // and before the API starts, so the privileged surface is ready the moment it answers.
  let adminCeremony: GrantAdminResult | undefined;
  const adminDid = assignment.actors.admin?.did;
  if (adminDid) {
    abortIfInterrupted(ctx);
    adminCeremony = await grantAdmin({
      did: adminDid,
      adminDatabaseUrl: ctx.pg.adminUrl,
      logFile: ceremonyLogFile(ctx.logDir, "bringup"),
    });
    process.stdout.write(
      `• admin ceremony: ${adminCeremony.outcome} for the run's administrator\n`,
    );
  } else {
    process.stdout.write(
      "• no administrator to grant — this run has no identity, so the privileged surface is BLOCKED\n",
    );
  }

  // ── 8. the API, on the restricted role ───────────────────────────────────────────────────────
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
      appId,
      verificationKey,
      analyticsHmacKey,
      allowPrivateHosts: true,
      embeddingProvider:
        process.env.E2E_EMBEDDING_PROVIDER === "openai" ? "openai" : "deterministic",
      openaiApiKey: process.env.OPENAI_API_KEY,
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

  // Every other level signs in AFTER the API is answering, so the login proves the whole round
  // trip — the provider accepted the code, and this API accepted the token the page then sent.
  if (identity.level !== "L3-BROWSER-ONLY") {
    browserSession = await establishBrowserSession(ctx, {
      dashboardUrl,
      apiUrl,
      awaitApiSession: true,
      tenantAcknowledged: identity.tenant.acknowledged,
    });
  }

  // ── 8. warm the dashboard routes ─────────────────────────────────────────────────────────────
  // `next dev` compiles per route on first request. A 20-second expect timeout inside a spec is
  // there for the analytics buffer, not for webpack, so the compile happens here instead.
  abortIfInterrupted(ctx);
  process.stdout.write("• warming dashboard routes…\n");
  for (const route of ["/", "/listings", "/keys", "/review", "/admin", "/duplicates", "/account"]) {
    await fetch(`${dashboardUrl}${route}`, { redirect: "manual" }).catch(() => undefined);
  }

  // ── 9. the state file ────────────────────────────────────────────────────────────────────────
  const degradedNoPrivy = identity.level === "L4-NO-PRIVY";
  const state: RunState = {
    runId: ctx.runId,
    startedAt: new Date().toISOString(),
    level: identity.level,
    blocked: assignment.blocked,
    conditional: assignment.conditional,
    ports: {
      api: apiPort,
      dashboard: dashboardPort,
      fixture: ctx.fixture.port,
      postgres: ctx.pg.port,
    },
    urls: {
      api: apiUrl,
      dashboard: dashboardUrl,
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
    preflight: {
      tenantAcknowledged: identity.tenant.acknowledged,
      appIdMasked: identity.tenant.appIdMasked,
      identities: identity.identities.length,
      browserLogin: identity.browserLoginAvailable,
      notes: identity.notes,
      failures: identity.failures,
    },
    adminCeremony: adminCeremony?.outcome,
    actorSeed,
    permutation: Object.fromEntries(
      Object.entries(assignment.actors).map(([name, actor]) => [name, actor.did]),
    ),
    previousAdminDid: previousAdmin(assignment.actors.admin?.did),
    logs: { api: api.logFile, dashboard: dashboard.logFile },
    privyAppId: appId,
    degradedNoPrivy,
    storageStatePath: browserSession?.storageStatePath,
    browserDid: browserSession?.did,
    inertVerificationKey,
  };

  if (degradedNoPrivy) {
    state.blocked.push({
      area: "every criterion that needs a real, provider-issued session",
      reason:
        "the run is at the no-identity level: the stack boots and the negative-authentication surface " +
        "is exercised in full, but nothing that requires a legitimate access token can be executed",
      unblockedBy: ["E2E_PRIVY_TENANT_ACK", "E2E_PRIVY_TEST_EMAIL", "E2E_PRIVY_TEST_OTP"],
    });
  }

  recordAssignment(state);
  writeState(ctx.statePath, state);
  writeIdentities(ctx, identity, browserSession);
  armTokenSource(ctx, identity);

  process.stdout.write(`• stack ready · level ${state.level}\n`);
  return state;
}

/**
 * Points THIS process's token source at the run's identity material.
 *
 * Two things made this necessary, and they are the same mistake in two places.
 *
 * First, the credentials are allowed to come from `packages/api/.env` — that is the documented
 * fallback, and the preflight honours it. But the child environment was being assembled by
 * re-reading `process.env.PRIVY_APP_ID` / `PRIVY_APP_SECRET`, which are simply absent in that
 * arrangement. Workers then received no minting credential at all and `tokenForDid` failed for
 * every identity except the browser's. The values the preflight actually LOADED are the only
 * correct source, so they are what gets published here.
 *
 * Second, `--check-m3` in real mode mints tokens in the RUNNER, not in a Playwright worker — and
 * the pointers used to be set up inside `runPlaywright`, a function that path never calls. Setting
 * them here, once, at the end of bring-up, means both consumers are armed by the same code and
 * neither can drift from the other.
 */
function armTokenSource(ctx: Context, identity: PreflightResult): void {
  process.env[IDENTITIES_ENV] = ctx.identitiesPath;
  if (identity.credentials.appId) process.env[APP_ID_ENV] = identity.credentials.appId;
  if (identity.credentials.appSecret) process.env[APP_SECRET_ENV] = identity.credentials.appSecret;
}

/**
 * The cross-run assignment record: who was the bootstrap administrator last time.
 *
 * PRIVY TENANT USERS OUTLIVE THIS SUITE. The database goes away with its container, but the
 * identities do not — so every privilege a run grants has to be re-granted next time, and an
 * identity that was an administrator must come back as an ordinary account. That is a real property
 * with a real failure mode (a bootstrap list left too wide, a membership that outlived its
 * organisation), and it is only observable by comparing two runs.
 *
 * The record lives wherever `E2E_ASSIGNMENT_RECORD` points — deliberately an explicit opt-in path
 * outside the repository, because a file that silently accumulated identity assignments would be a
 * surprise. Absent the variable, nothing is written and nothing is asserted.
 */
function previousAdmin(currentAdminDid: string | undefined): string | undefined {
  const path = process.env.E2E_ASSIGNMENT_RECORD;
  if (!path) return undefined;
  try {
    const previous = JSON.parse(readFileSync(path, "utf8")) as { adminDid?: string };
    // Only interesting when this run rotated AWAY from it; the same identity in the same part
    // proves nothing about leakage.
    if (previous.adminDid && previous.adminDid !== currentAdminDid) return previous.adminDid;
  } catch {
    // No record yet — the first run of a pair. Not an error.
  }
  return undefined;
}

function recordAssignment(state: RunState): void {
  const path = process.env.E2E_ASSIGNMENT_RECORD;
  if (!path) return;
  const record = {
    runId: state.runId,
    actorSeed: state.actorSeed,
    adminDid: state.actors.admin?.did,
    permutation: state.permutation,
    at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

interface BrowserSession {
  storageStatePath: string;
  token: string;
  did: string;
}

/**
 * Drives a real email-OTP login through the dashboard's own modal, when one is configured.
 *
 * Returns `undefined` — rather than throwing — when the credentials are absent: that is not a
 * failure, it is a ladder level, and the criteria it makes unreachable are already recorded as
 * BLOCKED with the variables that would unblock them. A login that was CONFIGURED and then failed
 * is a different matter and does throw, because silently continuing would turn "the login is
 * broken" into "the browser criteria were skipped", which is the report saying the wrong thing.
 */
async function establishBrowserSession(
  ctx: Context,
  options: {
    dashboardUrl: string;
    apiUrl: string;
    awaitApiSession: boolean;
    /** The preflight's tenant verdict. Signing in is gated on it — see below. */
    tenantAcknowledged: boolean;
  },
): Promise<BrowserSession | undefined> {
  const email = process.env.E2E_PRIVY_TEST_EMAIL;
  const otp = process.env.E2E_PRIVY_TEST_OTP;
  if (!email || !otp) return undefined;

  // THE ACKNOWLEDGEMENT GATES THE LOGIN, not just the token minting.
  //
  // A login is the single most consequential thing this suite does to the identity tenant: it can
  // persist a user record, and teardown does not remove it. Having the preflight refuse an
  // unacknowledged tenant and then signing in to it anyway — because the email and code happened to
  // be set — would break the exact promise the acknowledgement exists to make.
  if (!options.tenantAcknowledged) {
    process.stdout.write(
      "• browser credentials are configured, but the tenant is not acknowledged — NOT signing in.\n" +
        "  Set E2E_PRIVY_TENANT_ACK to the app id to permit it.\n",
    );
    return undefined;
  }

  process.stdout.write("• signing in through the dashboard…\n");
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const { login } = await import("./privy/browser-login.js");
    const session = await login({
      browser,
      dashboardUrl: options.dashboardUrl,
      apiUrl: options.apiUrl,
      email,
      otp,
      awaitApiSession: options.awaitApiSession,
      storageStatePath: join(ctx.tmp, "auth", "storage-state.json"),
      failureScreenshotPath: join(ctx.logDir, "browser-login-failure.png"),
      consoleLogPath: join(ctx.logDir, "browser-console.log"),
    });
    process.stdout.write("  signed in; session state captured\n");
    return session;
  } finally {
    await browser.close();
  }
}

/**
 * The DID → credential map the workers mint from.
 *
 * Separate from `state.json` on purpose: `state.json` is identifiers and configuration, and keeping
 * it free of anything credential-shaped means it can be read, printed and folded into a report
 * without a second thought. This file holds the test-account addresses (and, at the browser-only
 * level, a harvested token), lives in the run's 0700 directory, is written 0600, and goes away with
 * the directory.
 */
function writeIdentities(
  ctx: Context,
  identity: PreflightResult,
  browserSession?: BrowserSession,
): void {
  // The credential for each DID comes straight from the preflight that minted it. Nothing is
  // matched, guessed, or reconstructed from a masked value — see `MintedIdentity.exactEmail`.
  const records: IdentityRecord[] = identity.identities.map((minted) => ({
    did: minted.did,
    ...(minted.exactEmail ? { email: minted.exactEmail } : {}),
    ...(minted.exactPhone ? { phone: minted.exactPhone } : {}),
  }));

  // The browser-harvested token, when there is one. At the browser-only level it is the run's ONLY
  // source of a real credential and cannot be re-minted, so it is written here rather than left in
  // a process that is about to hand the work to Playwright workers.
  if (browserSession) {
    const existing = records.find((record) => record.did === browserSession.did);
    if (existing) existing.token = browserSession.token;
    else records.push({ did: browserSession.did, token: browserSession.token });
  }

  writeFileSync(ctx.identitiesPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

/**
 * An exclusive lock on the dashboard's dev cache.
 *
 * `next dev` keeps a per-directory build cache and its own lock inside `.next/`. Two concurrent E2E
 * runs would share it and corrupt each other's compile state in ways that surface as unrelated,
 * unreproducible spec failures. Refusing the second run with a clear message is strictly better
 * than supporting a configuration that cannot work.
 */
function acquireNextLock(ctx: Context): void {
  // BESIDE `.next/`, not inside it. `next dev` clears and recreates parts of that directory on
  // start, which silently deleted a lock file kept there — and a lock that a lock-protected process
  // deletes on its way up is not a lock at all. This location is the dashboard package directory,
  // which nothing else rewrites.
  const lockPath = join(dashboardDir, ".e2e-next-lock");
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
  // Forwarded from what `armTokenSource` published, NOT re-read from `PRIVY_*`: the credentials may
  // legitimately have come from `packages/api/.env`, in which case those variables do not exist in
  // this process at all.
  //
  // The app secret reaches the Playwright child (and only it) so workers can re-mint short-lived
  // tokens during a long run. Under a DIFFERENT variable name than the API reads, so it can never
  // be inherited into an API process by accident. See `tokens.ts` for the full reasoning.
  for (const key of [IDENTITIES_ENV, APP_ID_ENV, APP_SECRET_ENV]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
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
      problems.push(`releasing the dashboard lock: ${(err as Error).message}`);
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
