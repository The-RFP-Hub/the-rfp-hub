# Deploying the API — configuration, secrets and database credentials

How configuration reaches the running container, which parts of it are secret, which database
credential does what, and the one-time remediation owed for secrets that were baked into earlier
images.

Everything on this page outside the repository — task definitions, Secrets Manager entries,
database roles, Actions caches — is **operator work**. The repository holds the guard rails
(`scripts/check-deploy.mjs`, `.dockerignore`, the `Dockerfile`) and this runbook; it cannot and
must not hold the values.

---

## 1. The rule: nothing is baked into the image

The image carries code and data only. It is pushed to a registry and cached — with
`cache-to: type=local,mode=max` — in **this public repository's** Actions cache, so anything
inside a build layer is readable by anyone who can pull the image or read that cache.

Three things enforce this, and CI fails if any of them is undone:

| Guard | Where |
|---|---|
| The `Dockerfile` copies no env file and passes no `--env-file` flag | `Dockerfile` |
| `.dockerignore` excludes `.env`, `.env.*`, `**/.env`, `**/.env.*` | `.dockerignore` |
| No workflow writes a fetched secret into the build context | `.github/workflows/*.yml` |

`pnpm check:deploy` (`scripts/check-deploy.mjs`) reads all three and runs in CI before the build.

Configuration reaches the container **at task start**, from the ECS task definition.

---

## 2. Task-definition wiring

The container definition carries two lists. The distinction is not cosmetic: `environment` values
are visible to anyone who can `describe-task-definition`, and `secrets` values are not.

* **`secrets`** — every value whose disclosure is a compromise. Each entry names a **key inside**
  the JSON secret, so one Secrets Manager entry per environment holds them all:

  ```json
  { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:us-east-1:<account>:secret:staging/rfp-hub:DATABASE_URL::" }
  ```

  The `:KEY::` suffix is what selects a JSON key; without it the container receives the whole JSON
  document as the variable's value.

* **`environment`** — the non-secret tunables. Putting these in `secrets` too is not "safer": it
  makes every rotation a task-definition revision and hides operational settings from the people
  who have to reason about them.

### Secret values → `secrets`

| Variable | Secret key | What it is |
|---|---|---|
| `DATABASE_URL` | `DATABASE_URL` | **Runtime** connection string — the low-privilege role of §3, never the DDL role |
| `BETTER_AUTH_SECRET` | `BETTER_AUTH_SECRET` | Signs every session token, and is checked before any database access. **≥32 random characters, different per environment** — the process refuses to boot without it under `NODE_ENV=production`. **Rotating it signs everyone out**: there is no dual-secret verification, so plan a rotation as a deliberate global sign-out |
| `GOOGLE_CLIENT_SECRET` | `GOOGLE_CLIENT_SECRET` | Only when Google sign-in is enabled. Absent → the provider is not registered at all |
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | Embedding provider credential. Absent → the deterministic provider, and dedupe reports itself unavailable rather than failing a submission |
| `ANALYTICS_HMAC_KEY` | `ANALYTICS_HMAC_KEY` | Keys the session/IP HMAC. **Never baked**: a leaked key makes the whole IPv4 space brute-forceable against the stored hashes. Unset → a random per-boot key and a warning |

### Non-secret settings → `environment`

| Variable | Typical deployed value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Also what makes `VERIFY_ALLOW_PRIVATE_HOSTS` and the non-delivering email transports refuse to boot |
| `BETTER_AUTH_URL` | the API's own origin | The base every auth route and OAuth callback is built from. **Not** `PUBLIC_BASE_URL`, which is the OpenAPI document's `servers[0].url` and may legitimately differ |
| `TRUSTED_ORIGINS` | the frontend's origin(s) | Comma-separated, **exact** origins. Backs CSRF, the `callbackURL`, the handoff redirect target and the `/api/auth/*` CORS allowlist — one list so they cannot drift apart |
| `PREVIEW_ORIGIN_PATTERN` | staging only | An **anchored** regular expression for preview origins, tied to our project *and* team slug. Never `*.vercel.app`. Unanchored → refuses to boot |
| `EMAIL_TRANSPORT` | `ses` | How sign-in codes are delivered. `file`/`stdout`/`memory`/`null` **refuse to boot** in production: nothing would be delivered and every sign-in would stall at the code prompt, for everyone at once, with nothing in the logs |
| `EMAIL_FROM` | `no-reply@ethrfps.app` | The envelope sender. Its domain needs SPF/DKIM/DMARC, or the codes land in spam |
| `AWS_SES_REGION` | the SES region | **No credential** — the task role carries it. That is why SES was chosen over an API-key provider |
| `GOOGLE_CLIENT_ID` | per environment | Absent → no Google provider, no button. Pairs with the secret above |
| `PORT` | `3004` | Set in the `Dockerfile` so it always matches the container port and target group |
| `HOST` | `0.0.0.0` | |
| `DB_POOL_MAX` | `10` | Bound it on a shared instance |
| `PUBLIC_BASE_URL` | the API's **own** origin, https | Published as `servers[0].url`; never the specification's apex |
| `TRUST_PROXY` | the load balancer's CIDR, or a hop count | **Not a boolean.** Blanket trust lets any client spoof `X-Forwarded-For`, and that header is an analytics input. Unset → no proxy is trusted |
| `EMBEDDING_PROVIDER` | `openai` \| `deterministic` | `deterministic` needs no key and is what CI runs |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | |
| `EMBEDDING_TIMEOUT_MS` | `5000` | |
| `DEDUPE_SIMILARITY_THRESHOLD` | per-provider default | Thresholds are **not** comparable between providers |
| `DEDUPE_MAX_MATCHES` | `5` | |
| `VERIFICATION_ENABLED` | `true` | |
| `VERIFY_ON_SUBMIT` | `true` | Off in tests |
| `VERIFY_TIMEOUT_MS` | `10000` | |
| `VERIFY_MAX_BYTES` | `2097152` | Streamed cap |
| `VERIFY_QUEUE_MAX` | `100` | Full → the submit-time trigger is skipped and the entry stays in the job's predicate |
| `VERIFY_ALLOW_PRIVATE_HOSTS` | **never set in ANY deployed task definition** — service or maintenance, staging or production | A deliberate SSRF escape hatch that exists so one integration test can drive the real fetcher against a loopback server. Setting it in a deployment would let a submitted `applicationUrl` reach the instance metadata endpoint and the private network. The process **refuses to boot** with it enabled under `NODE_ENV=production`, so this row is defence in depth rather than the only control |
| `VERIFIER_EGRESS_PROXY` | optional | The network-layer backstop; application-level address validation should not be the only control |
| `ANALYTICS_ENABLED` | `true` | |
| `ANALYTICS_RETENTION_DAYS` | `180` | Enforced by the retention sweep, not by the schema |
| `STALENESS_INACTIVE_DAYS` | `90` | |
| `SUBMISSION_PENDING_LIMIT` | `5` | How many entries one account may leave awaiting review at once, when it holds no verified membership anywhere. A ceiling on the queue — every decision frees a slot — and verified publishers are exempt. Raising it raises how much of a reviewer's queue a single account can occupy |

Use a **separate `BETTER_AUTH_SECRET` per environment** — development, staging and production each
with their own — so a session minted for one environment cannot authenticate against another. That
isolation is now cryptographic and checked locally: the secret is HMAC-verified before any database
access, so a staging token presented to production fails on the signature, even though both
deployments run the same schema.

#### Google sign-in, per environment

Ships dark until the two variables above are set: with no `GOOGLE_CLIENT_ID` the provider is not
registered, the route does not exist and the frontend renders no button. When enabling it, create
**one Web client per environment** (consent screen `openid email profile`, no offline access — we
never call a Google API on a user's behalf) with the redirect URI:

```
{BETTER_AUTH_URL}/api/auth/callback/google
```

The callback lands a host-only `HttpOnly` cookie on the API's own origin, which the frontend — a
different origin — cannot read. `GET /api/auth-handoff` converts it to a one-time token and
redirects to the frontend carrying it in the **fragment**, which is not sent to servers and does
not appear in access logs or `Referer`. That is a narrowing, not a guarantee: the receiving page
scrubs the URL before its first `await`, the token is single-use with a three-minute life, and only
the server-side handoff can mint one (`disableClientRequest`). `returnTo` is validated against
`TRUSTED_ORIGINS` and reduced to an origin — it is the only route in this API that takes a redirect
target, so it is the only one that could be an open redirect.

#### Email delivery

Sign-in is a one-time code, so **email is on the critical path of every login**: if it does not
arrive, nobody signs in. SES was chosen because it needs no long-lived credential — the task role
carries it — which is one less secret to rotate and one less to leak.

Before the first deploy, confirm: `EMAIL_FROM`'s domain has SPF, DKIM and DMARC records, and the
account is **out of the SES sandbox** in the target region (in the sandbox, SES silently refuses
every address you have not verified — which presents as "the code never arrived").

---

## 3. Two database credentials, not one

| Role | Used by | Privileges |
|---|---|---|
| **Migration role** | the one-off migration task only | `CREATE`/`ALTER`/`DROP` in the schema, plus `CREATE EXTENSION` |
| **Runtime role** | the service (`DATABASE_URL` above) | `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the application tables; **no DDL**, and **no `UPDATE`/`DELETE` on `audit_log`** |

The append-only property of `audit_log` is enforced by a database trigger shipped as a migration
(`BEFORE UPDATE OR DELETE … RAISE EXCEPTION`), so it holds in every environment including a
developer's laptop. The revoke below is **defense in depth**, not the mechanism — it names a
deployment-specific role, which is exactly why it is not a migration:

```sh
psql "$ADMIN_DATABASE_URL" -v role=rfphub_runtime -f packages/api/scripts/sql/harden-audit.sql
```

---

## 4. Prerequisite: confirm the vector extension is available

M3 adds `CREATE EXTENSION IF NOT EXISTS vector` as a migration. Whether the managed instance
permits it is a property of the engine version and the parameter group, and it is **not recorded in
this repository** — check the instance, do not assume:

```sql
SHOW rds.extensions;   -- 'vector' must appear in the list
```

If it does not: raise the engine version and/or add `vector` to `shared_preload_libraries` in the
parameter group **before** applying any M3 migration. A migration that fails half-way through leaves
the schema between two versions.

---

## 5. Applying migrations

Migrations are a deliberate operator step. The image exposes the migration entry point, so a
one-off task on the **image being deployed** applies exactly the migrations that image ships:

```sh
node packages/api/dist/migrate.js     # inside the image; DATABASE_URL = the MIGRATION role
```

Locally, against a database you own:

```sh
DATABASE_URL=… pnpm --filter @the-rfp-hub/api migrate
```

### Runtime privileges on the identity tables

**Immediately after the migrations, in the same ceremony**, as an ADMIN/owner connection:

```sh
psql "$ADMIN_DATABASE_URL" -v role=rfphub_runtime -f packages/api/scripts/sql/grant-auth.sql
```

Run beside `harden-audit.sql` (§7) and for the same reason it is not a migration: a `GRANT` names a
**role**, and role names are a property of a deployment rather than of the schema.

**This is the single most likely production-only failure of the identity system.** The migrations
run as the migration role, which owns the tables it creates; the service runs as a different,
restricted role, and a table it does not own grants it nothing by default. Skip this step and the
schema is perfectly correct, every test still passes, and **every login 500s** — `SELECT` on
`auth_session` refused. It prints back the sixteen privileges it granted (four tables × SELECT,
INSERT, UPDATE, DELETE) so the operator can see the state rather than assume it. `DELETE` is not
optional: without it a sign-out cannot remove the session row, which is the whole revocation
property.

Four explicit grants, deliberately **not** `ALTER DEFAULT PRIVILEGES`: default privileges would
silently grant on every table a future migration creates, which is exactly what `harden-audit.sql`
argues against in its own closing comment. A fifth identity table means editing that file — and
that edit is the point.

### The first administrator

A one-time step in the same ceremony, with the same credential, because it is the one grant the
product cannot make itself — every route that grants `admin` requires an admin. **The person must
sign in once first**, so that an identity exists to promote:

```sh
DATABASE_URL=… pnpm --filter @the-rfp-hub/api grant-admin -- --email you@example.org --create --yes
```

The address is a **lookup**: it resolves through the identity table to the opaque subject the
`accounts` row stores. An address nobody has signed in as is a refusal that says so.

It echoes the `host:port/database` it resolved (never the URL — that carries a password), refuses a
non-loopback target without `--allow-remote`, refuses to write without `--yes`, exits non-zero on
any refusal, and is idempotent. **No environment variable grants a role**; after this, admins are
granted and revoked in the product, and the same command is how a lockout is recovered. See
[auth.md](auth.md#administrators).

### Gating deploys on migrations

Staging deploys on every push to the default branch while migrations are manual, so code can reach
staging before the tables it needs exist. The intended fix is a `migrate` job between `build_image`
and `deploy-ecs-service` in both deploy workflows — `aws ecs run-task` on the newly built image with
a container override of `["node","packages/api/dist/migrate.js"]`, the migration credential, and
`deploy-ecs-service` gaining `needs: [build_image, migrate]`.

It is **not wired in yet**, and deliberately so: it needs a task definition, subnets and security
groups, and a migration-role secret that must exist first. Wiring it before those exist would fail
every deploy. Create them, prove one run with a manual `workflow_dispatch`, then add the `needs`
edge.

### The identity migration: order is not optional

Migration `0006` swaps the account join key and drops the legacy identity columns. The old image
reads a column the new schema no longer has, and the new image reads a column the old schema does
not have yet — so there is a window, and the order below is what keeps it short and recoverable
rather than mysterious. Both environments will be **signed out**: every session predates the
identity tables.

| # | Step | What skipping or reordering it costs |
|---|---|---|
| 1 | Announce the window. | — |
| 2 | **Stop the API service** (desired count → 0). | The running old image queries the dropped column during step 3 and errors on every authenticated request. |
| 3 | **Run `0006`** as the migration role, on the image being deployed. It drops the legacy columns **and** applies the orphan policy. **Record the revoked-key count it reports.** | Running it after the deploy: the new image queries `auth_user_id` against a table that has no such column. |
| 4 | **Apply `grant-auth.sql`** as the admin/owner connection. | Every login 500s while every test stays green. See above. |
| 5 | **Deploy the new API image** with `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `EMAIL_TRANSPORT=ses`, `EMAIL_FROM`, `AWS_SES_REGION`. Scale back up. | — |
| 6 | **Rebuild and redeploy the frontend.** Its public variables are inlined at build time, so redeploying the old build keeps it pointing at the old identity provider. | The frontend sends credentials the new verifier cannot read: 401 on everything. |
| 7 | **Smoke:** sign in by email, confirm the code arrives from SES, `GET /v1/me` returns your address and role. | — |
| 8 | **The first admin signs in, then the operator runs `grant-admin --email`.** | **Every account is a `submitter` until this is done** — by design, see below. |

**The orphan policy, and why the rows stay.** Every `accounts` row that predates the swap loses its
join key: nobody can authenticate as one again. `0006` demotes each to `submitter`, clears
`direct_create`, and revokes its API keys. Left alone, an orphaned admin would still satisfy the
last-admin guard — a lockout that looks healthy from the inside — and its API keys would still be
live credentials, because key verification never consults the identity column. The **rows are not
deleted**: `audit_log` points at `accounts.id`, and history is not something a migration may erase.
No audit row is written for those revocations either — the trail has no "migration" actor — which is
why step 3 asks the operator to record the count the migration reports.

**Rollback is: redeploy the previous images and rebuild the database.** `0006` is destructive and
has no down-migration; the dropped columns and the revoked keys are not recoverable from the schema.
That is acceptable only while no deployment holds identities anybody wants back. Stated here so
nobody discovers it during an incident.

---

## 6. Running the maintenance jobs

The nightly maintenance work runs as **one-off tasks on the API service's own task definition** —
not a dedicated one — started by `.github/workflows/jobs-nightly.yml` with the credentials the
deploy workflows already hold:

```sh
node packages/api/dist/jobs.js <job> --json      # inside the image, as a container override
```

A job is the deployed image with a different command, so it inherits everything already assembled
in the service's task definition — the image, the runtime `DATABASE_URL`, every secret in
`secrets:` (§2), the execution and task roles — and the deploy workflows keep it current
automatically; there is no second copy of that list to fall out of step. Subnets, security groups
and launch type are not configured either: `run-ecs-job.sh` reads them off the running service with
`aws ecs describe-services` at task-start time, so the job lands exactly where the API lands.

There is **no public job endpoint and no shared job token**, deliberately: a credential that can
start a job has to live somewhere, and a token in repository secrets that the internet-facing API
accepts forever is a worse somewhere than the deploy role that already exists.
`POST /v1/admin/jobs/{job}/run` is a signed-in administrator's convenience, not a machine
credential.

### Operator prerequisites

One variable **per environment**: `<ENV>` is `PRODUCTION` or `STAGING`, and the workflow picks it
from its `environment` input — which is empty on the schedule and therefore `production`, matching
the deployment the open-data export reads. The credentials are picked the same way
(`<ENV>_AWS_ACCESS_KEY_ID` / `<ENV>_AWS_SECRET_ACCESS_KEY`), so a scheduled maintenance chain
authenticates exactly as `production.yml` does.

| Repository variable | What it names |
|---|---|
| `<ENV>_ECS_CLUSTER` | The cluster the one-off task runs in — the **same** variable `<env>.yml` already requires to deploy the service, so any deployed environment has already set it |

That is the only repository variable the chain needs. The task definition family
(`rfp-hub-<env>`), the container name and the service (`rfp-hub-<env>-service`) are the names the
deploy workflows already hardcode; `run-ecs-job.sh` derives them from `<env>` rather than reading a
second copy of them from configuration.

The one thing that may still be missing is **IAM**, not a repository variable: the deploy user
needs `ecs:RunTask` on the task definition and `iam:PassRole` for its execution and task roles.
Registering a task definition and updating a service — which the deploy workflow already does —
does not imply the right to start a task from it. This is likely already granted, since the same
user is the one registering the task definition being started.

Until `<ENV>_ECS_CLUSTER` is set, or before that environment has a deployed service to read, the
scheduled run announces a `::warning::` and stays green — the open-data export is chained to that
workflow, and failing over a resource that has never existed would stop the dataset publishing. A
**manual `workflow_dispatch` fails instead**, so an operator validating the wiring gets a real
answer, and the message names what is missing. Prove it with one dispatch per environment before
relying on the schedule.

### A dedicated task definition is optional

Nothing here needs one: reusing the service's own task definition means there is no separate
`secrets`/`environment` (§2) to keep in step by hand, which is the failure mode a dedicated
definition would introduce for no benefit. The one case where a **separate** task definition earns
its keep is a job that needs a credential the service must never hold — the gated migration job
sketched in §5 ("Gating deploys on migrations") is exactly that: it needs the **migration role**,
not the runtime one, and giving the service's task definition DDL access for one scheduled job would
be a much larger blast radius than provisioning a second, migration-only definition for it. Nothing
in the nightly maintenance chain needs that; it is noted here for when that job exists.

The full schedule, the idempotency and locking guarantees, and the per-job configuration are in
[`jobs.md`](./jobs.md).

---

## 7. Remediation owed: rotate, then purge

**Treat this as an incident, not a cleanup.**

Until the change that added this document, the deploy workflows fetched the whole `staging/rfp-hub`
/ `production/rfp-hub` secret into the build context and the `Dockerfile` copied it into the image
with `COPY .env* ./`. Those images are in the registry, and the `mode=max` buildx layer cache that
also carried the file is stored in **this public repository's** Actions cache. Anyone who could pull
an image, or read that cache, could read every value.

Removing the mechanism does not un-disclose anything already published. In order:

1. **Rotate every value** in `staging/rfp-hub` and `production/rfp-hub` — database passwords,
   identity-provider app secrets, third-party API keys, the analytics HMAC key. Rotate at the
   source system (issue a new key, then revoke the old one), not only in Secrets Manager.
2. **Move each value into the task definition** per §2 and roll the service onto a new revision.
3. **Purge the Actions caches** so the cached layers are gone:
   ```sh
   gh cache list  --limit 100
   gh cache delete --all
   ```
   The cache keys to be sure of are the buildx ones (`…-buildx-*`, `…-buildx-prod-*`).
4. **Delete or expire the affected image tags** in the registry, or at minimum stop treating any
   pre-remediation tag as deployable. A lifecycle policy that expires untagged images does not
   remove a tagged one.
5. **Review access logs** for the window the values were exposed — registry pulls and database
   authentication failures are the two that show use of a leaked credential.
6. **Re-check** with `pnpm check:deploy` and by inspecting the newly built image:
   ```sh
   docker run --rm --entrypoint sh <image> -c 'ls -a /app | grep -i env || echo "no env file"'
   ```

Rotation is step 1 for a reason: every later step is worthless while the old values still work.

---

## 8. `pnpm.overrides`, and why `better-auth` needs three of them

The root `package.json`'s `pnpm.overrides` block exists to keep `pnpm audit --prod --audit-level
moderate` — the gate `.github/workflows/security-audit.yml` runs weekly — clean. Most entries pin a
single transitive package past a known advisory (`@fastify/static`, `brace-expansion`, `fast-uri`,
`fastify>find-my-way`, `postcss>nanoid`) and are self-explanatory from the pin alone. Three exist for
a less obvious reason, worth recording so the next `better-auth` bump does not silently reopen them:

**`better-auth@1.7.1` declares `vitest` and `drizzle-kit` as PEER dependencies, not real ones** — a
correct choice for a library that must not version-lock its host's test runner or migration tool.
But this project's own root `vitest` devDependency satisfies that peer, and pnpm's peer resolution
wires it into the graph under `better-auth`'s node. `pnpm audit --prod` walks that graph from a
production dependency (`better-auth` itself, a real `dependencies` entry in both `packages/api` and
`packages/frontend`) and counts everything reachable from it — including the peer-satisfied
`vitest` and everything transitively beneath it (`vite`, `postcss`, `esbuild`) — as production
exposure. None of it is runtime-reachable; the audit gate cannot tell the difference.

**A scoped override (`"better-auth>vitest": ">=X"`) does NOT work for this.** It was tried first, and
`pnpm install` accepted it silently but left the actually-installed peer untouched (confirmed via
`pnpm -r why --prod vitest` before and after) — pnpm's override rewriting targets real dependency
edges, and a peer satisfied by the workspace's own hoisted devDependency has no such edge for the
scoped path to rewrite. The only fix that actually moves the installed version is bumping the real
devDependency: **root `vitest` and `packages/frontend`'s `vitest` both went from `^2.1.8` to
`^3.2.7`**, which is a real (if incidental) test-runner upgrade, not a pin. It was regression-verified
against every suite that uses `testAuth`/`testUtils` plus the full root and frontend runs before
being treated as safe — see the validation trail in this change's report.

**`vite` still needed a global override.** Bumping `vitest` alone left its own `vite` peer resolving
to the newest 5.x patch available (`5.4.21`), which the advisory covers (fixed only from `6.4.3`).
`"vite": "7.3.6"` pins it inside both `vitest@3.2.7`'s accepted peer range (`^5 || ^6 || ^7.0.0-0`)
and `@vitejs/plugin-react@4.7.0`'s (`^4.2 || ^5 || ^6 || ^7`). The override alone was **not
sufficient for `@vitejs/plugin-react`'s own peer slot** — it kept resolving to whatever the latest
published `vite` was (`8.x`, itself unaffected but outside both accepted ranges) until `vite` was
also added as an explicit `packages/frontend` devDependency pinned to the same `7.3.6`, giving that
peer a real edge to anchor on. Confirmed stable across three consecutive `rm -rf node_modules &&
pnpm install` cycles before being treated as deterministic.

**Two separate `esbuild` chains needed their own pins**, because they are unrelated dependency paths
that happen to share a package name: `vite>esbuild` (vite's own bundled copy) and
`@esbuild-kit/core-utils>esbuild` (pulled in by `drizzle-kit`'s legacy `@esbuild-kit` loader, a
different peer chain entirely). Both are pinned to `>=0.28.1` — not the advisory's stated `>=0.25.0`
floor, because `>=0.25.0` alone re-resolved to `0.27.x`, which a *second*, lower-severity esbuild
advisory (Windows dev-server file read) also covers; `>=0.28.1` clears both in one pin.

**Recheck all three on every `better-auth` version bump.** They are pinned to what `1.7.1`'s peer
ranges currently accept; a future `better-auth` release can shift those ranges (or drop the `vitest`/
`drizzle-kit` peers entirely) and make some or all of this unnecessary — or insufficient. Re-verify
with `pnpm -r why --prod vitest`, `pnpm -r why --prod vite`, `pnpm -r why --prod esbuild`, then
`pnpm audit --prod --audit-level moderate`, before assuming the pins still apply.

Five other, older overrides (`@coinbase/cdp-sdk>axios`, `viem>ws`, `@metamask/utils>uuid`,
`@metamask/sdk>uuid`, `@metamask/sdk-communication-layer>uuid`) were removed in the same change:
leftovers from the wallet-login dependency tree the Better-Auth migration deleted, confirmed orphaned
(zero resolutions anywhere in the lockfile, `pnpm -r why` for each returning nothing) before removal.
