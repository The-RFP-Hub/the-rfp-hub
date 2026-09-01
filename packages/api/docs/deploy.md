# Deploying the API — configuration, secrets and database credentials

How configuration reaches the running container, which parts of it are secret, which database
credential does what, and the one-time remediation owed for secrets that were baked into earlier
images.

Everything on this page outside the repository — task definitions, Secrets Manager entries,
database roles, Actions caches — is **operator work**. The repository holds the guard rails
(`scripts/check-deploy.mjs`, `.dockerignore`, the `Dockerfile`) and this runbook; it cannot and
must not hold the values.

> **Nothing is baked into the image any more.** The deploy workflows fetch nothing into the build
> context and the Dockerfile copies no `.env`; configuration is assembled into the ECS task
> definition by the deploy job instead. §2 describes both where that stands today — every value in
> the container's `environment` array, readable in-account — and where it is going, the `secrets:`
> array, which needs AWS-side wiring. Every value that travelled the old baked-`.env` path must
> still be **rotated** (§7): the layer cache it passed through is readable history.

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

Configuration reaches the container **at task start**, from the ECS task definition. The DEPLOY job
is what assembles that definition: it reads the environment's Secrets Manager value, parses it with
`scripts/env-to-container-env.mjs`, and registers a revision carrying the values — after the image
is built, in a different job, with nothing written next to the Dockerfile.

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

### Interim: everything is in `environment`

**The two lists above are the destination, not the present.** Today the deploy job puts every value
— including the ones this page marks secret — in the container's `environment` array, because
moving them into `secrets` is work only an operator with AWS access can do: reshape the Secrets
Manager entry into JSON keys, write the `secrets` array, grant the execution role
`secretsmanager:GetSecretValue` on it. The repository's own alternative was leaving the values in a
public repository's layer cache, so the interim was taken deliberately.

One entry is the workflow's rather than the secret's: `APP_BASE_URL` comes from the
`<ENV>_APP_BASE_URL` repository variable and is written on top of the secret's entries (`--set` in
the render step), so the value in the task definition is always the one the variable holds.

What it costs:

* every value is readable by any principal that can call `ecs:DescribeTaskDefinition` in the
  account, and by anyone looking at the task definition in the ECS console;
* `RegisterTaskDefinition` sends the values as request parameters, so assume **CloudTrail** holds
  them for its retention period;
* a revision is immutable, so it **freezes** the values it was registered with: rotating a secret
  changes nothing that is running until a deploy runs, and rolling the service back to an older
  revision restores that revision's credentials along with its image.

What it does not cost: nothing is in the image, in a build layer, or in the `mode=max` layer cache
this **public** repository stores — which is the exposure this replaced, and the larger one.

`PORT` and `NODE_ENV` are **skipped**, not injected (`--skip PORT,NODE_ENV`). The `Dockerfile` sets
both, and a task definition's `environment` outranks the image's `ENV`: injecting them would let an
edit to the secret move the port away from the container port and target group wired up in AWS, or
turn production into development. Everything else in the secret is injected, and a name whose value
is blank there is dropped — `readOptional` in `src/config.ts` already treats a blank value as unset.
`DATABASE_URL` and a ≥32-character `BETTER_AUTH_SECRET` are required: missing either, the deploy
fails before registering anything and the old revision keeps serving.

**Migrating to `secrets` is the deletion of one workflow step.** Once the `secrets` array exists and
the execution role can read it, delete the "Read configuration from Secrets Manager" step from both
workflows and drop the `--env` argument from "Render the task definition"; that step then sets only
the image, which is all the action it replaced ever did. The deploy gate accepts a `DATABASE_URL`
from **either** list, so it keeps passing throughout. A partial move is caught rather than deployed:
`scripts/env-to-container-env.mjs` refuses to render a name that appears in both `environment` and
`secrets`, because ECS resolves one of them and silently ignores the other.

### Secret values → `secrets`

| Variable | Secret key | What it is |
|---|---|---|
| `DATABASE_URL` | `DATABASE_URL` | **Runtime** connection string — the low-privilege role of §3, never the DDL role |
| `BETTER_AUTH_SECRET` | `BETTER_AUTH_SECRET` | Signs every session token, and is checked before any database access. **≥32 random characters, different per environment** — the process refuses to boot without it under `NODE_ENV=production`. **Rotating it signs everyone out**: there is no dual-secret verification, so plan a rotation as a deliberate global sign-out |
| `GOOGLE_CLIENT_SECRET` | `GOOGLE_CLIENT_SECRET` | Only when Google sign-in is enabled. Absent → the provider is not registered at all |
| `MAILGUN_API_KEY` | `MAILGUN_API_KEY` | Only when `EMAIL_TRANSPORT=mailgun`. The HTTP Basic password for the send (the user is the literal `api`). Missing → the service boots **degraded**: a loud warning, the four code-sending routes answering 503 until the pair is complete, everything that sends nothing serving normally |
| `ANALYTICS_HMAC_KEY` | `ANALYTICS_HMAC_KEY` | Keys the session/IP HMAC. **Never baked**: a leaked key makes the whole IPv4 space brute-forceable against the stored hashes. Unset → a random per-boot key and a warning |

### Non-secret settings → `environment`

| Variable | Typical deployed value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Also what makes `VERIFY_ALLOW_PRIVATE_HOSTS` and the non-delivering email transports refuse to boot |
| `BETTER_AUTH_URL` | the API's own origin | The base every auth route and OAuth callback is built from. **Not** `PUBLIC_BASE_URL`, which is the OpenAPI document's `servers[0].url` and may legitimately differ |
| `APP_BASE_URL` | the frontend's canonical origin | Required in production. The one origin placed in notification-email links; never inferred from the API's `PUBLIC_BASE_URL` or the preview-capable `TRUSTED_ORIGINS` list. The deploy workflows read `<ENV>_APP_BASE_URL` from repository variables and write it into the ECS task definition, which the dispatcher task then inherits |
| `TRUSTED_ORIGINS` | the frontend's origin(s) — `https://ethrfps.app` in production, `https://staging.ethrfps.app` in staging | Comma-separated, **exact** origins. Backs CSRF, the `callbackURL`, the handoff redirect target and the `/api/auth/*` CORS allowlist — one list so they cannot drift apart. The production frontend is the **apex**: it is the spec's site, and it proxies `/schemas/`, `/meta/`, `/registries/` and `/ns/` back to this service ([`adr/0007`](../../../adr/0007-canonical-domain-and-spec-identity.md)) |
| `PREVIEW_ORIGIN_PATTERN` | staging only | An **anchored** regular expression for preview origins, tied to our project *and* team slug. Never `*.vercel.app`. Unanchored → refuses to boot |
| `EMAIL_TRANSPORT` | `ses` or `mailgun` | How sign-in codes are delivered. Those two are the delivering transports; `file`/`stdout`/`memory`/`null` **refuse to boot** in production: nothing would be delivered and every sign-in would stall at the code prompt, for everyone at once, with nothing in the logs |
| `EMAIL_FROM` | `no-reply@ethrfps.app` | The envelope sender. Its domain needs SPF/DKIM/DMARC, or the codes land in spam |
| `AWS_SES_REGION` | the SES region | `ses` only. **No credential** — the task role carries it. That is why SES was chosen over an API-key provider |
| `MAILGUN_DOMAIN` | the sending domain, e.g. `mg.ethrfps.app` | `mailgun` only. A path segment of the send URL, not a property of the message: it is the domain whose DKIM records Mailgun holds, and it is normally a **subdomain** of `EMAIL_FROM`'s domain. Missing → same **degraded** boot as the key above: sign-in code delivery disabled with an explicit 503, never a dead service |
| `MAILGUN_API_BASE` | unset (US), or `https://api.eu.mailgun.net` | `mailgun` only. The regional endpoints are different hosts holding different accounts, so the wrong one is a 401 on every message rather than a slow path. Must be https for any host that is not loopback — every send carries the key in an `Authorization` header |
| `GOOGLE_CLIENT_ID` | per environment | Absent → no Google provider, no button. Pairs with the secret above |
| `PORT` | `3004` | Set in the `Dockerfile` so it always matches the container port and target group |
| `HOST` | `0.0.0.0` | |
| `DB_POOL_MAX` | `10` | Bound it on a shared instance |
| `PUBLIC_BASE_URL` | the API's **own** origin, https | Published as `servers[0].url`; never the specification's apex |
| `TRUST_PROXY` | the load balancer's CIDR, or a hop count | **Not a boolean.** Blanket trust lets any client spoof `X-Forwarded-For`, and that header is an analytics input. Unset → no proxy is trusted |
| `EMBEDDING_PROVIDER` | `lexical` \| `disabled` | Needs no key and no network — the in-process lexical featurizer is the default and the detector everywhere, CI included |
| `DEDUPE_SIMILARITY_THRESHOLD` | per-provider default | Thresholds are **not** comparable between providers |
| `DEDUPE_MAX_MATCHES` | `5` | |
| `DEDUPE_OVERLAP_ENABLED` | `true` | The second arm — length-corrected term overlap, which catches a shortened re-listing that cosine cannot. `false` is a real rollback: pairs carry a `rules_key` derived from the effective configuration, so flipping this makes them stale and the nightly `embedding-backfill` retires them within a run or two — no constant to bump, no release to cut. The same is true of every row below |
| `DEDUPE_OVERLAP_THRESHOLD` | per-provider default (`lexical` 0.85) | **Not bounded by 1** — cosine times a norm ratio, valid range (0, 4]. Not comparable between providers, for the same reason the similarity threshold is not |
| `DEDUPE_OVERLAP_MIN_TOKENS` | `20` | Distinct tokens required on the shorter side. The only guard measured to blunt a stub built from a target's rarest terms. Lowering it buys recall on short entries with a real exposure; `pnpm --filter @the-rfp-hub/api dedupe:threshold` prints the current trade rather than this row quoting a number that goes stale |
| `DEDUPE_OVERLAP_MIN_SIMILARITY` | `0.35` | The overlap arm's cosine floor. **Not** a security control — the arm only sees cosine-ordered ANN candidates and this makes that explicit |
| `NOTIFICATION_QUEUE_MAX` | `100` | Waiting immediate email ids; full → reject the newest id to the nightly durable sweep |
| `VERIFICATION_ENABLED` | `true` | |
| `VERIFY_ON_SUBMIT` | `true` | Off in tests |
| `VERIFY_TIMEOUT_MS` | `10000` | |
| `VERIFY_MAX_BYTES` | `2097152` | Streamed cap |
| `VERIFY_QUEUE_MAX` | `100` | Full → the submit-time trigger is skipped and the entry stays in the job's predicate |
| `VERIFY_RECHECK_DAYS` | `30` | How old a check may be before the entry is fetched again. Without a TTL an entry is checked exactly once, and `staleness` then closes the rolling half of the corpus 90 days later |
| `VERIFY_NIGHTLY_LIMIT` | `500` | Entries one `verification-backfill` **invocation** checks — not one pass: the job always reports `remaining: 0` so `--passes` cannot multiply it, and to drain a backlog you raise `--limit`. The TTL means the selection never drains, so this cap, not the predicate, is what bounds the nightly run |
| `VERIFY_HOST_MIN_GAP_MS` | `1000` | Minimum gap between two backfill fetches to the **same host**. A corpus clusters by publisher, so without it a serial pass is dozens of requests to one domain in the seconds it takes that domain to answer them, and a block reads back as "every entry from this publisher stopped matching". It is also what makes one pass minutes long: `POST /v1/admin/jobs/{job}/run` therefore defaults to a 10-entry slice (§4c of `jobs.md`) rather than `VERIFY_NIGHTLY_LIMIT`. **Leave it at the default in every deployment** — `0` disables pacing and exists for the e2e stack, whose only source host is a fixture server the runner itself started |
| `VERIFICATION_RUNS_KEEP` | `5` | Runs kept per entry. Pruned on every run insertion — manual and submit-time checks included — and again over the backfill's whole selection. Each run carries up to 200 KB of `snapshot_text`, so this is what bounds the table |
| `VERIFY_ALLOW_PRIVATE_HOSTS` | **never set in ANY deployed task definition** — service or maintenance, staging or production | A deliberate SSRF escape hatch that exists so one integration test can drive the real fetcher against a loopback server. Setting it in a deployment would let a submitted `applicationUrl` reach the instance metadata endpoint and the private network. The process **refuses to boot** with it enabled under `NODE_ENV=production`, so this row is defence in depth rather than the only control |
| `VERIFIER_EGRESS_PROXY` | optional | The network-layer backstop; application-level address validation should not be the only control |
| `ANALYTICS_ENABLED` | `true` | |
| `ANALYTICS_RETENTION_DAYS` | `180` | Enforced by the retention sweep, not by the schema |
| `STALENESS_INACTIVE_DAYS` | `90` | |

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
arrive, nobody signs in. SES is the default because it needs no long-lived credential — the task
role carries it — which is one less secret to rotate and one less to leak. **Mailgun** is the
alternative for a deployment that already operates it, or that has no task role to lend SES: it
costs one secret (`MAILGUN_API_KEY`) and is otherwise one HTTPS call, with no SDK in the image.

Before the first deploy, confirm — for either transport — that `EMAIL_FROM`'s domain has SPF, DKIM
and DMARC records. Then, whichever one you run:

* **SES:** the account is **out of the sandbox** in the target region. In the sandbox, SES silently
  refuses every address you have not verified — which presents as "the code never arrived".
* **Mailgun:** `MAILGUN_DOMAIN` is **verified** in the account, and it is the SENDING domain
  (`mg.ethrfps.app`), not `EMAIL_FROM`'s domain — an unverified or merely mistyped domain is a 401
  on every message. Set `MAILGUN_API_BASE` if the account is in the EU region; the endpoints are
  different hosts holding different accounts, and the default is the US one.

All senders go through the central outbound-email port. Better-Auth composes OTP content in its
adapter; the duplicate domain composes notification content; neither selects a provider or controls
the envelope sender. Newly committed duplicate notifications enter a bounded, best-effort
in-process queue, which joins `auth_user` for the address and attempts delivery immediately without
making the request wait. `notification-dispatch` is the daily backstop in the nightly maintenance
chain ([`jobs.md`](./jobs.md) §2); it retries temporary failures three times with a five-minute
floor. Provider refusals are recorded on the durable row rather than thrown through either the
request or the job.

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

### Never regenerate a migration that has already run somewhere

Drizzle decides what to apply by comparing each journal entry's `when` with the newest `created_at`
in `drizzle.__drizzle_migrations` — not by hash, and not by tag. So editing an applied migration in
place and letting `drizzle-kit` move its `when` **re-offers that migration to any database that
already ran the earlier form of it**, where its `ADD COLUMN`s abort on columns that are already
there. Migrations run in a transaction, so the whole file rolls back: the new columns never appear,
every later `migrate` fails on the same statement, and the deployment runs against a schema its
code no longer matches. That is exactly what left `opportunity_duplicates.rules_key` missing after
0011 was regenerated, and it 500'd every duplicate read until 0011 was made re-runnable.

If a change to an unreleased migration is genuinely wanted, it must be written so that applying it
to **either** state converges — `ADD COLUMN IF NOT EXISTS`, `DROP COLUMN IF EXISTS` for whatever
the superseded form added. Otherwise add a new migration and leave the old one alone. Since
migrations here are a manual operator step rather than a deploy gate, "nothing is deployed yet" is
never something the repository can tell you.

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
`accounts` row stores. An address nobody has signed in as is a refusal that says so. `--create` is
there because signing in makes the identity but not the `accounts` row — that is provisioned lazily
on the identity's first authenticated `/v1` request, which has not happened yet immediately after
sign-in. Without `--create` the same run refuses with "no account for that subject".

It echoes the `host:port/database` it resolved (never the URL — that carries a password), refuses a
non-loopback target without `--allow-remote`, refuses to write without `--yes`, exits non-zero on
any refusal, and is idempotent. **No environment variable grants a role**; after this, admins are
granted and revoked in the product, and the same command is how a lockout is recovered. See
[auth.md](auth.md#administrators).

### Gating deploys on migrations

Staging deploys on every push to the default branch that touches the API's build inputs (the
workflow's `paths:` filter names them; frontend-only and `exports/` pushes deploy nothing) while
migrations are manual, so code can reach
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
| 5 | **Deploy the new API image** with `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`, `EMAIL_TRANSPORT=ses`, `EMAIL_FROM`, `AWS_SES_REGION` — or `EMAIL_TRANSPORT=mailgun`, `EMAIL_FROM`, `MAILGUN_DOMAIN` and the `MAILGUN_API_KEY` secret. Scale back up. | — |
| 6 | **Rebuild and redeploy the frontend.** Its public variables are inlined at build time, so redeploying the old build keeps it pointing at the old identity provider. | The frontend sends credentials the new verifier cannot read: 401 on everything. |
| 7 | **Smoke:** sign in by email, confirm the code arrives through the configured transport, `GET /v1/me` returns your address and role. | — |
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
not a dedicated one. The nightly chain is scheduled **outside this repository**
([`jobs.md`](./jobs.md) §2 and §4d), and **this repository holds no maintenance workflow**: the
external scheduler is the only nightly caller, and an operator who needs a job run outside that
starts the same one-off task by hand ([`jobs.md`](./jobs.md) §4a). Either way the command is the
same:

```sh
node packages/api/dist/jobs.js all --json        # inside the image, as a container override:
                                                 # the whole chain, ordered in-process
node packages/api/dist/jobs.js <job> --json      # or one job by name
```

A job is the deployed image with a different command, so it inherits everything already assembled
in the service's task definition — the image, the runtime `DATABASE_URL`, every secret in
`secrets:` (§2), the execution and task roles — and the deploy workflows keep it current
automatically; there is no second copy of that list to fall out of step. Placement is not configured
either: the launch type (or capacity provider strategy) and the placement constraints are read off
the running service with `aws ecs describe-services` at task-start time and passed verbatim, so the
job lands exactly where the API lands. **The deployment runs EC2 with `bridge` networking and a
caller must assume that** — no `--network-configuration` is passed, because there is none to pass.

There is **no public job endpoint and no shared job token**, deliberately: a credential that can
start a job has to live somewhere, and a token in repository secrets that the internet-facing API
accepts forever is a worse somewhere than the deploy role that already exists.
`POST /v1/admin/jobs/{job}/run` is a signed-in administrator's convenience, not a machine
credential.

### Operator prerequisites

Two repository variables are configured **per environment**, `<ENV>` being `PRODUCTION` or
`STAGING`. Neither is read by a maintenance workflow any more — there is none — but both are still
what a maintenance run depends on, because the deploy workflow writes their values into the service
and the service is what a job inherits.

| Repository variable | What it names |
|---|---|
| `<ENV>_ECS_CLUSTER` | The cluster the service runs in, and therefore the one a one-off task runs in — the **same** variable `<env>.yml` already requires to deploy the service, so any deployed environment has already set it |
| `<ENV>_APP_BASE_URL` | Canonical HTTPS frontend origin. The API deploy writes it into the service task definition; notification-dispatch reuses that definition |

Neither reaches a job as a repository variable: the cluster is a name the caller passes on the
`aws ecs` command line, and `APP_BASE_URL` reaches the job through the service task definition. The
task definition family (`rfp-hub-<env>`), the container name and the service
(`rfp-hub-<env>-service`) are the names the deploy workflows already hardcode, and a caller derives
them from `<env>` rather than keeping a second copy of them in configuration.

The one thing that may still be missing is **IAM**, not a repository variable: the identity that
starts the task needs `ecs:RunTask` on the task definition and `iam:PassRole` for its execution and
task roles. Registering a task definition and updating a service — which the deploy workflow
already does — does not imply the right to start a task from it. For the deploy user this is likely
already granted, since it is the one registering the task definition being started.

Before that environment has a deployed service to read, there is nothing to start a job from: the
`describe-services` call fails and names it, which is the answer an operator validating the wiring
wants rather than a green run that did nothing. Prove it by hand, once per environment, before
pointing the external scheduler at the same tasks ([`jobs.md`](./jobs.md) §5).

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
2. **Run a deploy.** Rotating in Secrets Manager alone changes nothing while §2's interim is in
   force: the running configuration lives in the task definition revision, and only a deploy
   registers a new one.
3. **Delete the Actions caches** — every one of them, on the default branch especially, since that
   is the set a pull request from a fork can read:
   ```sh
   gh cache list  --limit 100
   gh cache delete --all
   ```
   The keys to be sure of are the buildx ones (`…-buildx-*`, `…-buildx-prod-*`). The key prefixes
   have been bumped to `…-buildx-v2-` / `…-buildx-prod-v2-` so a restore cannot quietly pull an old
   entry back, but a changed prefix is not a deletion: the old entries stay readable until deleted.
4. **Delete the affected image DIGESTS**, not just their tags. Untagging leaves the manifest
   pullable by digest, and a lifecycle policy that expires untagged images does not remove a tagged
   one:
   ```sh
   aws ecr batch-delete-image --repository-name staging-rfp-hub \
     --image-ids imageDigest=sha256:…
   ```
5. **Review access logs** for the window the values were exposed — registry pulls and database
   authentication failures are the two that show use of a leaked credential.
6. **Re-check** with `pnpm check:deploy` and by inspecting the newly built image:
   ```sh
   docker run --rm --entrypoint sh <image> -c 'ls -a /app | grep -i env || echo "no env file"'
   ```

Rotation is step 1 for a reason: every later step is worthless while the old values still work.

---

## 8. `pnpm.overrides` — the inventory, and how to retire an entry

The root `package.json`'s `pnpm.overrides` block exists to keep `pnpm audit --prod --audit-level
moderate` — the gate `.github/workflows/security-audit.yml` runs weekly — clean. **Every entry is
debt**: it pins a fact about somebody else's dependency graph, and the graph moves. The block is
kept to the entries an empirical check still proves load-bearing — *delete the override, `pnpm
install`, `pnpm audit --prod`*: if the advisory does not come back, the entry was dead weight and
stays out.

Why any of this is audit-visible at all: `better-auth` declares `vitest` and `drizzle-kit` as PEER
dependencies, this workspace's own devDependencies satisfy them, and pnpm wires the satisfied peers
into the graph under `better-auth`'s node — a real `dependencies` entry of both `packages/api` and
`packages/frontend`. `pnpm audit --prod` counts everything reachable from there (`vite`, `esbuild`,
`drizzle-kit`'s loader chain) as production exposure, runtime-reachable or not.

| Override | Forces | Advisories | Why it is reachable | Remove when |
|---|---|---|---|---|
| `@esbuild-kit/core-utils>esbuild` | `>=0.28.1` | GHSA-67mh-4wv8-2f99, GHSA-g7r4-m6w7-qqqr | `better-auth` (prod) → peer `drizzle-kit` → legacy `@esbuild-kit` loader → its own `esbuild` | `drizzle-kit` drops `@esbuild-kit` (its changelog has promised to). Verify by deletion: remove the line, `pnpm install`, `pnpm audit --prod` — clean means gone for good |
| `vite>esbuild` | `>=0.28.1` | same pair | `better-auth` (prod) → peer `vitest` → `vite` → its bundled `esbuild` | `vite` ships `esbuild >=0.28.1` in its own range. Same verify-by-deletion |

Both pin `>=0.28.1`, not the advisory's stated `>=0.25.0` floor: `>=0.25.0` re-resolved to
`0.27.x`, which a second, lower-severity esbuild advisory also covers; `>=0.28.1` clears both.
They are two entries because they are two unrelated dependency paths that share a package name.

**Retired entries, and why** (recorded so a red weekly audit has its history in one place): the
empirical remove-all-and-re-resolve check showed upstream caught up on `brace-expansion`,
`fast-uri`, `fastify>find-my-way` and `postcss>nanoid` — today's default resolution satisfies all
four advisories with no pin. `@fastify/static: 10.1.2` was needed only while `swagger-ui` was v5;
the API's `@fastify/swagger-ui@^6` pulls a fixed `static` in its own range. The global
`vite: 7.3.6` override was redundant with the real `packages/frontend` devDependency pinned to the
same version — the devDependency is what gives `@vitejs/plugin-react`'s peer slot a real edge to
anchor on, which is the part an override alone was proven not to reach.

**Recheck on every `better-auth` bump**: its peer ranges are what make the whole chain reachable.
`pnpm -r why --prod esbuild`, then the audit, before assuming anything still applies.

Five other, older overrides (`@coinbase/cdp-sdk>axios`, `viem>ws`, `@metamask/utils>uuid`,
`@metamask/sdk>uuid`, `@metamask/sdk-communication-layer>uuid`) were removed in the same change:
leftovers from the wallet-login dependency tree the Better-Auth migration deleted, confirmed orphaned
(zero resolutions anywhere in the lockfile, `pnpm -r why` for each returning nothing) before removal.
