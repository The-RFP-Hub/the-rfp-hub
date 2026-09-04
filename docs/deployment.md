# Deploying the RFP Hub

Top-down: what runs where, what has to exist in a cloud account **before** the first deploy, which
variables are required, how the first deploy is sequenced, how a release is cut, and how it is
rolled back.

This is the operator's map. The detail behind each box lives with the thing it describes —
[`packages/api/docs/deploy.md`](../packages/api/docs/deploy.md) for configuration, secrets and
database credentials, [`packages/api/docs/jobs.md`](../packages/api/docs/jobs.md) for the
maintenance chain, [`packages/frontend/README.md`](../packages/frontend/README.md) for the
frontend's own build. Where this page and the code disagree, the code is what runs.

Shell blocks are marked `no-run`, `safe-read` or `staging-write` — see
[the convention](./README.md#shell-blocks-carry-a-marker-and-the-marker-is-a-contract).

---

## 1. What runs where

| Component | Where it runs | How it gets there |
|---|---|---|
| **The API** (`packages/api`) | ECS on **EC2** with `bridge` networking, behind an Application Load Balancer | `.github/workflows/staging.yml` on every push to `main`; `.github/workflows/production.yml` on a `prod-*` tag |
| **Postgres** | a managed instance, with the `vector` extension available | provisioned by hand; migrations are a deliberate operator step |
| **The frontend** (`packages/frontend`) | Vercel, at the **apex** — it is the specification's site and it proxies `/schemas/`, `/meta/`, `/registries/` and `/ns/` back to the API | `.github/workflows/frontend-staging.yml` on a frontend-affecting push to `main`; `frontend-production.yml` on a `prod-*` or `frontend-prod-*` tag |
| **The open-data export** | a scheduled GitHub Actions job that reads the **live API** and commits the snapshot to `exports/` on the default branch | `.github/workflows/nightly-export.yml`, cron `17 3 * * *` |
| **Maintenance jobs** | one-off ECS tasks on the API service's **own** task definition | dispatched by a scheduler **outside this repository**; this repo holds no maintenance workflow |
| **npm packages** | the public registry | published **by hand** — see [§7](#7-npm-release-runbook-manual) |

Two properties of that arrangement are worth stating because they are easy to assume the other way:

* **The image carries no configuration.** Nothing is baked in; every value is assembled into the
  ECS task definition by the deploy job. That is why a rotated secret changes nothing until a
  deploy runs, and why rolling back a revision rolls the configuration back with it ([§8](#8-rollback)).
* **The nightly export publishes into this repository, not into a bucket.** Every snapshot is a
  commit, so "what did the dataset say last Tuesday" is `git log`. It reads the public API rather
  than the database, so it needs no database credential and is a check *on* the deployment.

### The apex is reserved

The apex serves the specification's own documents and nothing else of the API's. The reference
frontend claims none of those four path prefixes as app routes and proxies them straight through;
the API independently refuses `/v1/**` under an apex `Host` header. Two layers, because the
application rule survives an infrastructure edit and the infrastructure rule survives a routing
change in the code. Do **not** route the apex to the API wholesale: that would publish the whole
`/v1` surface at the identifier hostname and turn every future apex path into collision surface.

---

## 2. Prerequisites — say it out loud: there is no infrastructure-as-code

**This repository contains no Terraform, no CDK, no CloudFormation and no Pulumi.** Nothing here
creates a cluster, a load balancer, a database or a Vercel project. Everything in the table below
is created by hand, once per environment, before the first deploy — and if you are reading this
because you inherited the deployment, the account is the only record of what exists.

The repository holds the guard rails (`scripts/check-deploy.mjs`, `.dockerignore`, the
`Dockerfile`, the deploy workflows) and this runbook. It cannot hold the values, and it does not
hold the topology.

### AWS resources that must exist first

| Resource | Notes |
|---|---|
| **ECS cluster**, one per environment | Its name goes into the `<ENV>_ECS_CLUSTER` repository variable. An empty value silently means ECS's `default` cluster, which is why the workflow refuses to run while it is unset |
| **ECS service** `rfp-hub-<env>-service`, on a task definition family `rfp-hub-<env>` with a container named `rfp-hub-<env>` | The workflows hardcode these names and derive them from `<env>`; a job started by hand derives them the same way |
| **EC2 capacity** for that cluster, with `bridge` networking | A one-off task reads the launch type and placement constraints off the running service and passes them verbatim — there is no `--network-configuration` to pass, and a caller must assume EC2 + `bridge` |
| **ECR repositories** `staging-rfp-hub` and `production-rfp-hub` | Named in the workflows' `ECR_REPOSITORY_MAIN` |
| **Application Load Balancer** + target group on the container port **3004** | `PORT` is fixed in the `Dockerfile` so it always matches; that is why the deploy skips injecting `PORT` |
| **Secrets Manager entries** `staging/rfp-hub` and `production/rfp-hub` | One JSON document per environment holding the values of [§4](#4-environment-variables). The deploy job reads it and writes it into the task definition |
| **RDS / Postgres**, with `vector` available | Check the instance, do not assume: `SHOW rds.extensions;` must list `vector`. Raise the engine version and/or add `vector` to `shared_preload_libraries` **before** applying any migration that creates the extension |
| **Two database roles** | A migration role with DDL and `CREATE EXTENSION`; a runtime role with DML only, and no `UPDATE`/`DELETE` on `audit_log` |
| **IAM for the deploy identity** | Push to ECR, register a task definition, update the service — and, for maintenance jobs, `ecs:RunTask` on the task definition plus `iam:PassRole` for its execution and task roles. Registering a definition does not imply the right to start a task from it |
| **SES out of the sandbox** in the target region, or a verified Mailgun domain | Email is on the critical path of **every** login. In the sandbox SES silently refuses every unverified address, which presents as "the code never arrived" |
| **DNS + certificates** for the API host, the apex and the staging labels | Staging is a single label — `staging.` and `api-staging.`, not `api.staging.` — by the certificate rule |

### Vercel resources

| Resource | Notes |
|---|---|
| **A Vercel project** for `packages/frontend` | Its org and project ids become repository secrets |
| **Environment variables in Vercel**, per environment | `NEXT_PUBLIC_API_URL` is the only one the app requires, and it is **inlined at build time**, so which environment's variables `vercel pull` fetches decides which API the shipped bundle talks to. Nothing has to be set for indexing: production is detected automatically from the platform-provided `VERCEL_ENV`/`VERCEL_PROJECT_PRODUCTION_URL`, and previews stay `noindex` on their own |
| **Domains**: the apex (production) and the staging alias | The workflows alias the deployment after building |

### Repository variables and secrets the workflows read

`<ENV>` is `STAGING` or `PRODUCTION`. Settings → Secrets and variables → Actions.

| Name | Kind | Read by | What it is |
|---|---|---|---|
| `<ENV>_ECS_CLUSTER` | variable | `staging.yml`, `production.yml`, and any maintenance caller | The cluster name. A hosting-account resource name, deliberately not a literal in a source-neutral tree |
| `<ENV>_APP_BASE_URL` | variable | the same workflows | The canonical HTTPS frontend origin. Written **on top of** the secret's entries into the task definition, so the variable always wins; the notification dispatcher inherits it from that same definition |
| `<ENV>_AWS_ACCESS_KEY_ID` / `<ENV>_AWS_SECRET_ACCESS_KEY` | secrets | the deploy jobs | The deploy identity |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | secrets | both frontend workflows | Project-scoped |
| `DISCORD_WEBHOOK` | secret | the deploy notifications | Optional in the sense that only the notification step uses it |
| `NIGHTLY_EXPORT_DEPLOY_KEY` | secret, in the `nightly-export-publisher` environment | `nightly-export.yml` | The write deploy key that pushes the snapshot past the branch ruleset. Its environment admits only `main`, and it is held as an ssh key in `core.sshCommand`, never in `.git/config` |

Everything else — the AWS region (`us-east-1`), the ECR repository names, the ECS container and
service names — is a literal in the workflow files.

---

## 3. Prerequisites in the repository

Nothing below is infrastructure, and all of it is checked in CI:

* **Every `uses:` in every workflow is pinned to a full commit SHA**, with the release in the
  trailing comment. A tag is a mutable pointer; a job holding deploy credentials is exactly what
  moving one would be worth aiming at. Upgrading is a deliberate edit: read the release notes,
  change the SHA and the comment together.
* **`pnpm check:deploy`** asserts the three guards that keep configuration out of the image: the
  `Dockerfile` copies no env file, `.dockerignore` excludes `.env*`, and no workflow writes a
  fetched secret into the build context.
* **`pnpm check:neutral`** asserts the repository stays source-neutral and carries no retired
  identifier or off-domain URL.

---

## 4. Environment variables

The full table — every variable, its default and the reasoning behind it — is
[`packages/api/README.md` § Configuration](../packages/api/README.md#configuration) and
[`packages/api/.env-example`](../packages/api/.env-example). Which of them are secrets and how they
reach a container is [`packages/api/docs/deploy.md` §2](../packages/api/docs/deploy.md).

What follows is the operator's short list: the ones a deployment is wrong without.

### Required in production — the process refuses to boot without them

| Variable | Why |
|---|---|
| `DATABASE_URL` | The **runtime** role, never the DDL role. Under `NODE_ENV=production` the process exits non-zero at startup rather than silently using the localhost default. The deploy job refuses to register a task definition without it, so the old revision keeps serving instead of shipping a crash loop |
| `APP_BASE_URL` | The frontend's canonical origin — the one origin placed in notification-email links. Never inferred from the API's own base URL or from the preview-capable trusted-origin list. Remote origins must be HTTPS |
| `BETTER_AUTH_SECRET` | ≥32 random characters, **different per environment**, so a session minted for staging cannot authenticate against production. **Rotating it signs everyone out** — there is no dual-secret verification, so plan a rotation as a deliberate global sign-out |

### The checklist item that is easiest to get wrong: `TRUST_PROXY`

**`TRUST_PROXY` is not a boolean, and `true` is rejected at boot.** It takes a hop count (`1`) or a
comma-separated list of proxy addresses/CIDRs. Unset, nothing is trusted.

Behind the load balancer that matters twice over:

* `request.ip` is the **balancer's** address, not the client's. Rate limiting that meters by IP
  then meters the whole internet into **one bucket** — the ceiling is reached by aggregate traffic
  and every anonymous caller is throttled by every other one.
* The same address is an analytics input, which is why blanket trust is refused: `X-Forwarded-For`
  is client-supplied, and "believe whatever the caller says its address is" is not a setting worth
  offering.

A per-IP rate limit that is silently one shared bucket is worse than no rate limit, because it
reads as a control that is not there. Set it in the same breath as the load balancer.

### `TRUSTED_ORIGINS` decides who can sign in

Comma-separated, **exact** origins, compared whole — no suffix matching, no scheme guessing. It
backs CSRF, the sign-in `callbackURL`, the handoff redirect target and the `/api/auth/*` CORS
allowlist, deliberately as one list so those four cannot drift apart.

`/v1` is unaffected: it stays `origin: "*"` with `credentials: false`, because every `/v1`
credential is header-borne. **That asymmetry is the symptom to recognize** — a deployment whose
origin is not on the list serves the public directory perfectly and cannot log anybody in.

On staging only, `PREVIEW_ORIGIN_PATTERN` admits preview origins. It must be an **anchored**
regular expression tied to the project *and* team slug — never a bare `*.vercel.app`, which accepts
any tenant on the platform. An unanchored pattern is refused at boot.

### Rate limits are per process — N tasks multiply every ceiling

The per-route ceilings, which routes are metered, and how a key is chosen are in
[`packages/api/docs/auth.md` § Rate limits](../packages/api/docs/auth.md#rate-limits). The two
facts that belong to the **operator** rather than the integrator, and that a limit is meaningless
without:

* **The ceilings are per PROCESS.** The store is this process's own memory, so with **N** tasks
  behind the balancer every published number is multiplied by N — "60/min per account" across three
  tasks is 180/min in practice, because a caller's requests land wherever the balancer sends them.
  A shared store (Redis) would fix it and is not built. Size the numbers, and any statement made to
  an integrator, against the task count actually running.
* **`TRUST_PROXY` decides whether the address half works at all**, per the checklist item above.
  The key is `acct:<accountId>` when the request proved a credential and `ip:<address>` otherwise
  (grouped by /64 for IPv6), so without it every anonymous caller shares one bucket.

Three behaviors worth knowing before reading a graph of `429`s: an anonymous or invalid credential
is metered by address and is refused for being **over the limit before** it is refused for being
invalid; a credential-store outage — a `503 auth_unavailable` from the session lookup or a `500`
from the key lookup, both of them a failure to *check* a credential rather than to serve a request
— is never metered, so an outage does not spend anybody's budget; and any other response **is**
metered, `5xx` included, so a client retrying into a fault of ours eventually sees `429` instead of
the fault. The integrator's side of the same facts is [`api-integration.md` §4.8](./api-integration.md#48-rate-limits-are-per-credential-and-a-429-tells-you-when-to-come-back).

### The frontend's variables

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_GA_ID` are `NEXT_PUBLIC_`, **inlined at build time**, and
neither is a secret. `NEXT_PUBLIC_SITE_ORIGIN` is the same shape, but on Vercel there is nothing to
set for it: production indexing is detected automatically from `VERCEL_ENV` and
`VERCEL_PROJECT_PRODUCTION_URL`, which Vercel provides on every build and which are read
server-side, not as `NEXT_PUBLIC_` values. Setting any of these variables on a running host changes
nothing until the next build.

| Variable | Where it is set |
|---|---|
| `NEXT_PUBLIC_API_URL` | Every environment, and the only **required** one. The API's origin — where `/v1` lives, where sign-in lives, and what is written into the page's CSP `connect-src` |
| `NEXT_PUBLIC_SITE_ORIGIN` | **Nothing to set on Vercel.** There, the canonical, indexable origin is derived automatically: when `VERCEL_ENV === "production"` it is `https://` plus `VERCEL_PROJECT_PRODUCTION_URL`; any other `VERCEL_ENV` (preview) — or no Vercel environment at all, with the variable unset — stays `noindex`. Set this variable explicitly only on a copy deployed **off** Vercel that should opt into indexing; an explicit value always wins over the auto-detected one |
| `NEXT_PUBLIC_GA_ID` | **Optional**, and a production-only decision. A Google Analytics 4 measurement id (`G-…`). Unset — the default, and what every fork inherits — no analytics loads and the CSP names no Google origin at all. Set, the layout loads `gtag.js` and the policy opens exactly the Google origins GA4 needs, and nothing else. Turning it on has a privacy-page consequence: `src/app/privacy/page.tsx` has to keep describing what that deployment actually does. Details in [`packages/frontend/README.md`](../packages/frontend/README.md#environment) |

Leave `NEXT_PUBLIC_SITE_ORIGIN` unset on Vercel — production, staging and every preview alike — and
the platform-provided detection handles indexing with no configuration step. Set it only on a
self-hosted copy, or a copy deployed on a platform other than Vercel, that should be the indexable
one; unset there means `noindex` and `Disallow: /`, the fail-closed direction: forgetting it costs
that copy its search presence rather than costing a preview its privacy. Setting it on a second
copy makes that copy index itself and compete with the real site in search results.

### Indexing: how the canonical origin is decided

On Vercel this is not an operator step. Whichever canonical origin resolves — the auto-detected one
on Vercel, or an explicit `NEXT_PUBLIC_SITE_ORIGIN` on a copy deployed elsewhere — is compared
against the incoming **request's** origin by the layout, `sitemap.ts` and `robots.ts`, and only a
match indexes, sitemaps and allows crawling. Getting either side wrong does not fail a build, a
deploy or a health check: the site serves perfectly and is quietly `noindex`, with `robots.txt`
answering `Disallow: /`. The only symptom is that production never appears in search, weeks later.

Two things worth knowing if that happens:

* **`VERCEL_PROJECT_PRODUCTION_URL` is the host Vercel considers this project's production
  domain** — not necessarily a custom or aliased domain a visitor typed, if the project has more
  than one attached. If the apex is aliased or a custom domain was added after the project was
  created, confirm what Vercel reports as the production URL before assuming the detection is
  broken.
* **An explicit `NEXT_PUBLIC_SITE_ORIGIN`, on a copy deployed off Vercel, is compared character for
  character** against the request origin — scheme plus host, with the default port dropped
  (`https://example.org`, never `https://example.org:443`, never a trailing slash or a path),
  normalized through `URL().origin`. The request origin is derived from `X-Forwarded-Host` when a
  proxy sets it, otherwise `Host`, with the scheme from `X-Forwarded-Proto` (defaulting to
  `https`). Behind a CDN or a load balancer, set the variable to the public hostname.
* **An alias is not a second deployment.** `www.example.org` and any other alias must **redirect**
  to the apex at the edge. Pointing a second deployment at the alias and giving it its own canonical
  origin too produces two indexable copies of the same directory competing for the same listings;
  leaving that copy without one produces an alias that is reachable and invisible.

Verify it from outside, on the real hostname, right after the first production deploy:

```sh no-run
curl -sS https://example.org/robots.txt      # must NOT be "Disallow: /"
curl -sS https://example.org/sitemap.xml | head -5
```

`pnpm check:deployment --site https://example.org --only frontend --browser --expect-indexable`
makes that robots row a **required** check rather than an informational one — pass it for
production, and leave it off for staging and for any copy that is supposed to stay unindexed.

---

## 5. The first deploy, in order

The order below is the one that does not fail: build the image, create the schema with it, load
data, then start serving. Every step after the first is a **one-off task on the image being
deployed**, so the migrations that run are exactly the ones that image ships.

### 5.1 Build and push the image

Push to `main` (staging) or push a `prod-*` tag (production). The workflow builds
`Dockerfile` — a two-stage build that compiles the whole workspace and then reinstalls
production-only dependencies for the runtime image — pushes to ECR, and tags with the commit SHA.

Nothing is fetched into the build context. Do not add a step that does.

### 5.2 Migrate, as the migration role

```sh no-run
# a one-off ECS task on the image being deployed, container override:
node packages/api/dist/migrate.js
```

Then, **in the same ceremony**, as an admin/owner connection — these are `GRANT`s and a `REVOKE`,
which name deployment-specific roles and therefore cannot be migrations:

```sh no-run
psql "$ADMIN_DATABASE_URL" -v role=rfphub_runtime -f packages/api/scripts/sql/grant-auth.sql
psql "$ADMIN_DATABASE_URL" -v role=rfphub_runtime -f packages/api/scripts/sql/harden-audit.sql
```

**Skipping `grant-auth.sql` is the single most likely production-only failure of the identity
system.** The migrations run as the role that owns the tables; the service runs as a different,
restricted role, and a table it does not own grants it nothing by default. The schema is perfectly
correct, every test still passes, and **every login 500s**. The script prints back the sixteen
privileges it granted so the state is visible rather than assumed.

Never regenerate a migration that has already run somewhere. Drizzle decides what to apply by
comparing timestamps, not hashes, so editing an applied migration in place re-offers it to a
database that already ran the earlier form — where it aborts, rolls back the whole file, and leaves
every later `migrate` failing on the same statement. Add a new migration instead.

### 5.3 Seed, if this deployment starts from the curated corpus

```sh no-run
node packages/api/dist/seed.js packages/api/data/seed-corpus.json --strict
```

The corpus is a committed file passed as an argument — no network, no credentials, so a container
run loads exactly what CI loads. Under `--strict` one schema-invalid document fails the run; a
repeated id fails it either way; and the ≥100 floor is asserted **before the first write**, so a
short or broken run leaves the database untouched. The write phase is one transaction.

### 5.4 Deploy the service

The workflow registers the rendered task definition and updates the service with
`wait-for-service-stability`. Configuration is read from Secrets Manager **in the deploy job** and
written into the definition on the way past; `PORT` and `NODE_ENV` are deliberately skipped,
because a task definition's `environment` outranks the image's `ENV` and an edit to the secret
would otherwise be able to move the port away from the target group or turn production into
development.

### 5.5 The first administrator

One-time, with the migration credential, because it is the one grant the product cannot make
itself — every route that grants `admin` requires an admin. **The person must sign in once first**,
so that an identity exists to promote:

```sh no-run
# Against a deployed database this needs --allow-remote as well — see below.
DATABASE_URL=… pnpm --filter @the-rfp-hub/api grant-admin -- \
  --email you@example.org --create --allow-remote --yes
```

**Three flags, and leaving any of them out is a refusal rather than a surprise.** The script exits
non-zero and says which one it wanted:

| Flag | Why it is not the default |
|---|---|
| `--create` | Signing in makes the identity, but the `accounts` row is provisioned lazily on the first authenticated `/v1` request. Run right after sign-in — before the dashboard has ever loaded — the script finds an identity with no account, and this is what provisions one. It cannot conjure an identity that has never signed in |
| `--allow-remote` | The script refuses any `DATABASE_URL` whose host is not loopback, because the ordinary case is a developer's own machine and a remote host is a production database somebody meant to point elsewhere. A deployed run **always** needs it: `refusing: <host> is not loopback. Re-run with --allow-remote if that is the database you mean.` |
| `--yes` | It refuses to write at all without it |

`--allow-remote` is the flag to think about rather than paste. The alternative is to make the
target genuinely loopback — run the command from inside a one-off task on the deployed image, or
through an SSH/SSM port-forward to the database, so `DATABASE_URL` points at `127.0.0.1`. Either is
fine; what matters is that reaching a production database is a deliberate act. The script echoes
back the `host:port/database` it resolved — never the URL, which carries a password — so read that
line before answering for it.

No environment variable grants a role, deliberately — a role re-derived from configuration on every
request is granted to whoever holds the configuration and cannot be revoked in the product. The run
is idempotent: an account that is already an admin is a reported no-op.

### 5.6 Deploy the frontend

Push (staging) or tag (production). The build inlines `NEXT_PUBLIC_API_URL`, so **redeploy on every
configuration change** — setting the variable on a running host changes nothing.

### 5.7 Verify

```sh no-run
pnpm check:deployment --milestone m2 --api https://api.example.org --export-url https://data.example.org
```

The M2 profile is read-only: health and TLS, every operation in the *published* OpenAPI document
executed against the *live* service including the strict-`400` negative contract, every served
document validated against the Standard, and the export's freshness and alias-pair invariant.

```sh staging-write
pnpm accept:writes --milestone m3 --api https://api-staging.example.org --namespace my-org --session-token "$SESSION" --admin-token "$ADMIN"
```

`accept:writes --milestone m3` **writes** — the publisher lifecycle, the review queue, the audit
trail, duplicate detection, source verification, analytics and the staleness job. It refuses to
start without credentials and a namespace, and refuses any target that is not loopback or on the
staging allowlist — there is no flag that forces production. An admin credential is required so
the fixtures it creates can be torn down (unless the session token is itself a reviewer's).
Everything it creates is prefixed `compliance-` and is rejected and unlisted at the end.

```sh no-run
pnpm check:deployment --milestone m4 --site https://example.org --api https://api.example.org --browser
```

The M4 profile is read-only: its defaults already point at production, and the one case that
looks like a write — the MCP server's fail-closed submit — runs against a local recording server
the checker starts itself. It covers the governance documents and their links from the site, the public
`/publishers` page, the reference frontend's search, filters, paging, detail and both deep-links,
three responsive viewports, the MCP server being installable and callable, the agent skill, and
these guides' links and `safe-read` blocks.

**`--browser` is not optional in practice.** The directory and `/publishers` are client-rendered,
so without it every check that needs a rendered page reports a named `WARN` — never a silent pass,
and never a fail for something the tool did not look at. A **required** check that ends `WARN` or
`SKIP` makes the whole run `INCOMPLETE` and exits non-zero, so a green sign-off cannot be assembled
out of things the tool did not actually look at.

`--skip <id>` and `--only <id>` select checks. `--mcp-spec` chooses which MCP server is exercised —
a dist-tag (`next`), an exact version, or `local` for the checkout. `--json` writes the
machine-readable report; with no path it goes to a unique temporary file whose location is printed
on the last line, so two runs never overwrite each other.

**`--offline` applies to the documentation criterion only.** It is what the CI `docs-links` job
uses, and it does not put the rest of the tool offline: every other criterion still talks to the
site, the API, npm and the MCP Registry. Offline, the docs criterion still walks every `sh` block's
marker and still resolves every relative link and `#anchor`; what it drops is the absolute-link
requests and the execution of `safe-read` blocks. Run it as `--only docs --offline` — the
combination that means what it says — rather than expecting `--offline` alone to make a full run
network-free. See [`scripts/compliance/README.md`](../scripts/compliance/README.md).

```sh staging-write
COMPLIANCE_API_KEY=rfph_... COMPLIANCE_ADMIN_TOKEN=... \
  pnpm accept:writes --milestone m4 --api https://api-staging.ethrfps.app --interactive-approval
```

`accept:writes --milestone m4` is the write-acceptance counterpart, **staging only** — there is no
flag that points it at production. It drives the real MCP `submit_opportunity` interlock end to
end — preview, an out-of-band `rfphub-mcp approve`, commit — and tears its fixture down afterwards.
It is the same guard as the M3 profile — there is no flag that forces production. `--only`/`--skip`
may name only criteria in the selected `--milestone` profile — a key from the other one is refused
before any request is made (exit 2), because each profile's teardown only removes what that profile
wrote. **Both milestone profiles read the same three credentials** — `--session-token` /
`COMPLIANCE_SESSION_TOKEN`, `--admin-token` / `COMPLIANCE_ADMIN_TOKEN`, `--api-key` /
`COMPLIANCE_API_KEY` — and flags always win over the matching variable. Under `--milestone m4`,
`--api-key` is the write-scoped `rfph_` key handed to the MCP server for `submit_opportunity`, and
the reviewer credential that the teardown needs is `--admin-token`, or a `--session-token` belonging
to an account that can review.

`--interactive-approval` is the difference between evidence and a rehearsal. With it, the run
**pauses** and asks you to run `rfphub-mcp approve <id>` in a second terminal; the report then
labels the approval `HUMAN`. Without it the checker drives the approval CLI itself and labels it
`SIMULATED (non-interactive)` — honest, and useful in a loop, but it proves the plumbing rather
than the interlock. **The acceptance report handed to the client must be produced with
`--interactive-approval`**, and the label in the report is what says so.

#### Milestone criteria → checks

The two M3 numberings **diverge from M3-3 onward**, and both are real evidence. The compliance
checker's numbering is authoritative for the JSON `contractId`; the e2e numbering is what the
Playwright report prints. Both appear below, with the divergence stated.

| Milestone | Contract criterion (compliance checker) | `--only` key | tool | Also verified by the e2e suite as |
|---|---|---|---|---|
| M2 | M2-1 API liveness | `liveness` | `check:deployment` | — |
| M2 | M2-2 OpenAPI conformance | `openapi` | `check:deployment` | — |
| M2 | M2-3 Dataset | `dataset` | `check:deployment` | — |
| M2 | M2-4 Export freshness | `export` | `check:deployment` | — |
| M3 | M3-1 Publisher lifecycle | `lifecycle` | `accept:writes` | **M3-1** `04-lifecycle.spec.ts` |
| M3 | M3-2 Namespace review queue | `namespace` | `accept:writes` | **M3-2** `05-write-namespace.spec.ts` |
| M3 | M3-3 Audit trail | `audit` | `accept:writes` | **M3-4** `07-provenance-verification.spec.ts` |
| M3 | M3-4 Duplicate detection | `duplicates` | `accept:writes` | **M3-3** `06-duplicates.spec.ts` |
| M3 | M3-5 Source verification & snapshot | `verification` | `accept:writes` | **M3-4** `07-provenance-verification.spec.ts` |
| M3 | M3-6 Publisher analytics | `analytics` | `accept:writes` | **M3-5** `08-dashboard-analytics.spec.ts` |
| M3 | M3-7 Staleness job | `staleness` | `accept:writes` | **M3-6** `09-staleness.spec.ts` |
| M3 | — (hygiene, not a completion criterion) | `teardown` | `accept:writes` | — |
| M3 | — (no checker criterion) | — | — | **M3-7** `10-public-browse.spec.ts` |
| M3 | — (no checker criterion) | — | — | **M3-8** `11-organization.spec.ts` |
| M3 | — (no checker criterion) | — | — | **M3-9** `12-back-links.spec.ts` |
| M4 | M4-1 Governance published and linked | `governance` | `check:deployment` | — |
| M4 | M4-2 Public `/publishers` | `publishers` | `check:deployment` | — |
| M4 | M4-3 Reference frontend | `frontend` | `check:deployment` | **`13-responsive.spec.ts`** (the touch-target half) |
| M4 | M4-4 MCP server callable | `mcp` | `check:deployment` | — |
| M4 | M4-4b MCP server published | `mcp-publication` | `check:deployment` | — |
| M4 | M4-5 Agent skill published | `skill` | `check:deployment` | — |
| M4 | M4-6 Handoff documentation | `docs` | `check:deployment` | — |
| M4 | M4-ACCEPT 3-phase MCP submission | `submission-cycle` | `accept:writes` | — |

> **Why two M3 numberings.** The compliance checker numbers the *seven criteria it can exercise over
> HTTP*; the Playwright suite numbers the *nine areas a browser has to prove*, and it splits the
> audit trail and source verification differently (its M3-4 covers both, which the checker keeps
> apart as M3-3 and M3-5) and adds three areas with no HTTP-only equivalent. Neither numbering is
> wrong; a report cites the one belonging to the tool that produced it. `criteria[].contractId` in
> `compliance-report.json` always means the first column.

---

## 6. Running one-off tasks

`migrate`, `seed`, `export` and the maintenance chain are entry points **inside the same image the
service runs**, launched as one-off tasks with a container override. There is no second image, no
`tsx` and no TypeScript source in the runtime layer.

```sh no-run
node packages/api/dist/migrate.js                                    # apply pending migrations
node packages/api/dist/seed.js packages/api/data/seed-corpus.json    # load the curated corpus
node packages/api/dist/export.js                                     # write six files to ./exports
node packages/api/dist/jobs.js all --json                            # the whole nightly chain, ordered
node packages/api/dist/jobs.js <job> --json                          # one job by name
```

Run them **on the service's own task definition**. A job started that way inherits the image, the
runtime `DATABASE_URL`, every secret, and both IAM roles — there is no second copy of that list to
fall out of step, and the deploy workflows keep it current automatically. Placement is not
configured either: the launch type and placement constraints are read off the running service at
task-start time and passed verbatim, which is why the deployment being **EC2 with `bridge`
networking** is something a caller has to assume rather than something it can pass.

The export writes to `./exports` inside the container. Mount a volume over it if the output has to
outlive the task; the nightly publication does not, because it runs in Actions against the public
API instead.

There is **no public job endpoint and no shared job token**, deliberately: a credential that can
start a job has to live somewhere, and a token in repository secrets that the internet-facing API
accepts forever is a worse somewhere than the deploy role that already exists.
`POST /v1/admin/jobs/{job}/run` is a signed-in administrator's convenience, not a machine
credential.

A **dedicated** task definition is optional and mostly a liability — it introduces a second
`environment`/`secrets` list to keep in step by hand. The one case that earns it is a job needing a
credential the service must never hold: a gated migration job needs the **migration** role, and
giving the service DDL access for one scheduled job would be a much larger blast radius.

---

## 7. npm release runbook (manual)

**The release is manual in this milestone, on purpose.** There is no `changesets/action` with a
write credential in the repository. This is the maintainer's checklist; run it from a clean
checkout of the commit being released.

### 7.1 The order is an obligation, not a preference

```
@the-rfp-hub/standard  3.1.0   →  publish FIRST
rfphub-validate        0.3.1   →  publish SECOND
@the-rfp-hub/mcp       0.1.0   →  publish THIRD, with --tag next
```

`packages/validate/package.json` declares `@the-rfp-hub/standard` as `workspace:*`, and `npm
publish` rewrites that to the exact workspace version. Publishing the validator **before** the
Standard 3.1.0 exists on the registry produces a package that depends on a version nobody can
install — every consumer's `npm install` breaks, the frontend clean-room job included. Step 7.4 is
what makes that mistake impossible to miss.

### 7.2 Green first

```sh no-run
pnpm build && pnpm test && pnpm lint && pnpm check && pnpm check:neutral
```

### 7.3 Version

Every published package that changed needs a changeset in `.changeset/`. `changelog` is `false` in
`.changeset/config.json`, so `version` writes no CHANGELOG — the git history is the log.

```sh no-run
pnpm changeset version     # takes @the-rfp-hub/standard to 3.1.0 (pending minor changeset)
                           # and rfphub-validate to 0.3.1
git diff                   # review every version bump and every rewritten dependency range
git commit -am "chore: version packages for release"
```

### 7.4 Inspect the tarball before every publish — with `pnpm pack`, never `npm pack`

**This is the step where the wrong tool silently produces a broken package.** `pnpm pack` rewrites
the tarball's own `workspace:*` dependencies to the exact versions in the workspace at pack time,
which is what makes the tarball installable outside the monorepo at all. `npm pack` does not touch
`workspace:*` — a tarball built with it still declares `"@the-rfp-hub/standard": "workspace:*"` in
its own `package.json`, which `npm install` cannot resolve. Check inside the tarball, not in the
source tree.

```sh no-run
pnpm --filter @the-rfp-hub/standard pack --pack-destination /tmp/rfphub-pack
tar -xzOf /tmp/rfphub-pack/the-rfp-hub-standard-3.1.0.tgz package/package.json | less
#   version is 3.1.0; `files` carries schemas/, registries/, meta/, ns/, conformance/

pnpm --filter rfphub-validate pack --pack-destination /tmp/rfphub-pack
tar -xzOf /tmp/rfphub-pack/rfphub-validate-0.3.1.tgz package/package.json | less
#   THE CHECK: "@the-rfp-hub/standard" must read "3.1.0" — never "workspace:*"
tar -tzf /tmp/rfphub-pack/rfphub-validate-0.3.1.tgz | grep dist
grep -rl humanizeIssues /tmp/rfphub-pack/   # the export the frontend imports must be IN the build
```

The last check is the one that matters. `rfphub-validate` 0.3.0 shipped without `humanizeIssues`
while the source exported it, and an external copy of the frontend failed to typecheck against the
published package as a result — the failure that makes deploy path B need a local tarball until
0.3.1 is out.

### 7.5 Publish

```sh no-run
pnpm --filter @the-rfp-hub/standard publish --access public          # 3.1.0 — FIRST
pnpm --filter rfphub-validate publish --access public                # 0.3.1 — after the Standard resolves
pnpm --filter @the-rfp-hub/mcp publish --access public --tag next    # 0.1.0 — never straight to latest
```

`pnpm publish`, for the same reason as `pnpm pack`: it is what rewrites `workspace:*` on the way
out. It also runs its own git checks — a release cut from a tagged, clean checkout passes them, and
reaching for `--no-git-checks` to get past one is a reason to stop and look at why the tree is
dirty.

Add `--provenance` to each command **if** the publish runs from a CI job with an OIDC identity
registered with the registry. Publishing by hand from a laptop cannot produce provenance — do not
pass the flag there, and do not claim provenance in a README on a release cut that way.

### 7.6 Prove the `next` tag, then promote

```sh no-run
pnpm check:deployment --milestone m4 --site https://example.org --api https://api.example.org --browser \
  --only mcp --only mcp-publication --mcp-spec next
npm dist-tag add @the-rfp-hub/mcp@0.1.0 latest        # only after the M4 profile is green
```

`--mcp-spec next` is what makes the `mcp` check spawn `npx -y @the-rfp-hub/mcp@next` — the
published artifact — rather than the `packages/mcp/dist/cli.js` in the checkout, which is what it
falls back to so the check can run before anything is published at all. Proving the tag means
proving the **tarball on the registry**, so pass it explicitly here.

Nothing is promoted to `latest` on the strength of the publish succeeding. `latest` is what an
unpinned install resolves to, and it is the one decision that cannot be quietly taken back.

**Then re-run the frontend clean-room against the newly published ranges**, because 0.3.1 is what
unblocks it. Pass them explicitly — the script still defaults to the previous pair at this point:

```sh no-run
pnpm frontend:clean-room --browser --standard-spec '^3.1.0' --validate-spec '^0.3.1'
```

**Green here is what licenses the last step of the release: flip the script's defaults.**
`scripts/frontend-clean-room.mjs` hard-codes the fallback ranges (`^3.0.0` / `^0.3.0`) that
`--standard-spec` and `--validate-spec` override, and they are only correct while those are the
newest published versions. In one change:

* `scripts/frontend-clean-room.mjs` — the two fallback defaults, to `^3.1.0` and `^0.3.1`;
* the `clean-room` job in `.github/workflows/ci.yml` — its `clean-room-mode` dispatch input
  defaults to `packed` (build the validator from the checkout) precisely because `published` could
  not work; flip that default to `published`. Its `standard-spec` / `validate-spec` inputs are
  empty strings that fall through to the script's own defaults (passed through as
  `--standard-spec`/`--validate-spec` when set), so the previous bullet is what fixes them;
* `packages/frontend/README.md` and [§9](#9-the-frontend-three-ways-to-deploy-a-copy) of this guide
  — delete the local-tarball workaround from both, and the ranges quoted alongside it.

Leaving the defaults behind is not cosmetic: it is what keeps the next person's bare
`pnpm frontend:clean-room` proving the current release rather than the previous one.

### 7.7 The MCP Registry

The Registry does not follow npm: every version needs its own publish. It is done by the
**MCP Registry** workflow (`.github/workflows/mcp-registry.yml`), never from a laptop, because the
registry grants `io.github.<org>/*` to a person's GitHub token only when that person is an
**Owner** of the organization — a member gets a 403 that names only their personal namespace,
whatever its hint about public membership says — while the workflow's OIDC token gets the
namespace from the repository's owner, with no role involved.

Four steps, once the npm package of §7.5–7.6 is on the registry under the new version.

**1. The release commit carries the version everywhere.** `changeset version` bumps `package.json`
only; the same commit must move `packages/mcp/server.json` (`version` and `packages[0].version`)
and every pinned snippet in `packages/mcp/README.md` to the new number. `pnpm --filter
@the-rfp-hub/mcp test` fails until it does. The server reports `package.json`'s version, so
nothing in `src/` needs touching.

**2. Tag that commit and push the tag.** The workflow accepts only a tag — a branch or a bare SHA
is refused — so every Registry entry traces back to a release. Package tags take the
`<name>@<version>` form the other packages already use:

```sh no-run
git tag @the-rfp-hub/mcp@0.1.2            # on the commit whose server.json says 0.1.2
git push origin @the-rfp-hub/mcp@0.1.2
```

A `prod-*` tag on the same commit (§7.8) serves just as well. Tag **after** the npm publish of
that version, never before: the workflow reads `server.json` from the tag and refuses while npm
does not yet carry that version under that name. A tag pushed too early is not fixed by
publishing — delete it and push it again from the release commit:

```sh no-run
git push origin :refs/tags/@the-rfp-hub/mcp@0.1.2
git tag -f @the-rfp-hub/mcp@0.1.2 <release commit>
git push origin @the-rfp-hub/mcp@0.1.2
```

**3. Dispatch the workflow on the tag**, from the CLI or from Actions → MCP Registry → Run
workflow with `ref` set to the tag:

```sh no-run
gh workflow run mcp-registry.yml -f ref=@the-rfp-hub/mcp@0.1.2
gh run watch
```

It checks the tag out, refuses unless the npm package `server.json` names is on the registry at
that version with the same `mcpName`, logs in with the job's OIDC identity, publishes, and fails
unless the Registry serves the version afterwards.

**4. Confirm from the outside.** The `mcp-publication` criterion of `pnpm check:deployment
--milestone m4` reads the same Registry URL and compares it with the manifest in the checkout.

An Owner can still do the same by hand — `mcp-publisher login github`, then `mcp-publisher publish`,
from `packages/mcp` — but the tag and the checks above are what the workflow adds, and they are the
reason it exists.

**The namespace is `io.github.The-RFP-Hub`, in the organization's own case.** The registry grants
`io.github.<login>/*` spelled exactly as the GitHub login and matches it as a case-sensitive prefix,
and it compares the published npm package's `mcpName` to the server name character for character.
`mcpName` in `package.json` and `name` in `server.json` must be that exact string; the lowercase
name 0.1.0 and 0.1.1 shipped with could be published by nobody.

**Every configuration example in every README pins an exact version.** Never `@latest` in a snippet
somebody will paste into an agent's configuration: an example that floats hands whoever controls
the package the ability to change what a user already installed.

### 7.8 Tag to deploy production

```sh no-run
git tag prod-2026-09-09            # deploys the API and the frontend
git tag frontend-prod-2026-09-09   # deploys the frontend only
git push origin --tags
```

Production has no branch trigger at all. A push to `main` deploys **staging**; production moves
only on a tag, so a release is always an explicit act with a name in the history.

### 7.9 Click the Deploy Button once, end to end, and write down where it landed

The last step before handing the release to anybody, and the one nothing automated can stand in
for. Open the button's one canonical home —
[`packages/frontend/README.md`](../packages/frontend/README.md#deploying-your-own-copy) — click it,
take the flow all the way to a running deployment with `NEXT_PUBLIC_API_URL` set at the prompt,
load the directory, and **record the resulting URL** in the release notes. Delete the deployment
afterwards.

A Deploy Button is a URL carrying a build configuration — root directory, install command, build
command, the variable and its help text — and every one of those can be individually correct while
the whole thing fails at install time. CI proves the package builds from a clean copy
([§9 Path B](#path-b--copy-only-the-package-install-from-npm)); it does not prove that this URL,
today, produces a working deployment for somebody who has never seen the repository. Only the click
does. Do it on the released tag, not on `main`.

---

## 8. Rollback

### You cannot roll the API back by naming the old revision

**Both deploy workflows deregister the revision they replaced**, as the last step after a
successful deploy (`aws ecs deregister-task-definition`, `staging.yml` / `production.yml`). So the
obvious move —

```sh no-run
# DOES NOT WORK: that revision is INACTIVE, and ECS refuses to deploy from one.
aws ecs update-service --cluster "$CLUSTER" --service rfp-hub-production-service \
  --task-definition rfp-hub-production:<previous-revision>
```

— fails, and it fails at the worst possible moment. The deregistration is deliberate: a revision
freezes the configuration it was registered with, so the copy an immediate rollback would reach for
is also the copy most likely to hold a **superseded secret**. Rolling back means putting the
previous **image** back, with the **current** configuration.

### Preferred: re-run the pipeline at the last good commit

```sh no-run
git tag prod-2026-09-09-rollback <last-good-commit>
git push origin prod-2026-09-09-rollback
# staging: re-run the workflow with workflow_dispatch on that ref
```

This rebuilds the image and re-reads Secrets Manager, so the configuration is current by
construction and the path taken is the one that is tested every day. It costs a build.

### Fast path: register a new revision carrying the previous image

When a build is too slow, take the revision the service is running **now** as the base — it holds
the current configuration — and change only the image:

```sh no-run
FAMILY=rfp-hub-production
CLUSTER="$PRODUCTION_ECS_CLUSTER"
SERVICE=rfp-hub-production-service
CONTAINER=rfp-hub-production
PREVIOUS_IMAGE=<account>.dkr.ecr.us-east-1.amazonaws.com/production-rfp-hub:<previous commit sha>

# The image tag is the commit SHA the workflow pushed. Confirm the one you want exists:
aws ecr describe-images --repository-name production-rfp-hub \
  --query 'sort_by(imageDetails,&imagePushedAt)[-10:].[imageTags[0],imagePushedAt]' --output table

# The active revision carries plaintext configuration, so treat the file the way the deploy job
# does: 0600, out of the working tree, deleted at the end.
umask 077
aws ecs describe-task-definition --task-definition "$FAMILY" --query taskDefinition \
  > "$TMPDIR/td.json"

jq --arg image "$PREVIOUS_IMAGE" --arg container "$CONTAINER" '
      .containerDefinitions |= map(if .name == $container then .image = $image else . end)
    | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
          .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
  ' "$TMPDIR/td.json" > "$TMPDIR/td-rollback.json"

NEW_TD=$(aws ecs register-task-definition --cli-input-json "file://$TMPDIR/td-rollback.json" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_TD"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

rm -f "$TMPDIR/td.json" "$TMPDIR/td-rollback.json"
```

The `del(...)` is not optional: `register-task-definition` rejects the read-only fields
`describe-task-definition` returns. Rolling **forward** again is the ordinary deploy — no cleanup
of this revision is needed beyond the workflow's own deregistration of it next time.

### The caveats that survive both paths

* **A revision that is still ACTIVE still freezes its configuration.** The deregistration only runs
  on a *successful* deploy, so a failed one can leave an older revision usable. Deploying from it
  restores the credentials it was registered with, and a value rotated since will simply fail to
  authenticate. Prefer the two procedures above, which both carry current configuration.
* **Rolling the image back does not roll the schema back.** If the deploy being undone applied
  migrations, the previous image runs against the newer schema. Check what was applied before
  assuming an image swap is the whole rollback.
* **One migration in the history has no down-migration**: the identity swap is destructive, and its
  rollback is *redeploy the previous images and rebuild the database*. That is acceptable only
  while no deployment holds identities anybody wants back. Written here so nobody discovers it
  during an incident.

**The frontend.** Push a new `frontend-prod-*` tag pointing at the previous good commit. Rollback
is a git operation, not a console one, so the deployed state stays a fact in the history.

**The export.** Nothing to roll back: every snapshot is an immutable commit, artifacts are named by
digest, and the aliases move forward. Recovering an older dataset is checking out an older commit
of `exports/`.

---

## 9. The frontend: three ways to deploy a copy

The reference frontend is a Next.js app whose **only** required variable is `NEXT_PUBLIC_API_URL`,
**inlined at build time** — so it has to be present when the build runs, and setting it on a
running server does nothing. Anyone may deploy their own copy against the public API. Three paths, in
order of how little you need to know:

### Path A — the Deploy Button (clone the repository)

**The button lives in one place, and this is not it:**
[`packages/frontend/README.md` § Deploying your own copy](../packages/frontend/README.md#deploying-your-own-copy).
Click it there. A Deploy Button is a URL carrying the whole build configuration in its query string
— root directory, install command, build command, the environment variable and its help text — so
a second copy of it in a second document is a second build configuration that will drift from the
real one without anybody noticing. It already had.

What the button does, so you know what you are agreeing to: it clones the **repository** (not the
subdirectory) into your own Vercel account with the root directory set to `packages/frontend`,
which is what keeps `pnpm-lock.yaml` and the two workspace dependencies visible to the build —
Vercel enables "Include source files outside of the Root Directory" by default. It carries the pnpm
install and filtered build commands, so nothing has to be typed into the project settings. Set
`NEXT_PUBLIC_API_URL` when prompted, and leave `NEXT_PUBLIC_SITE_ORIGIN` unset — Vercel needs
nothing set for indexing, see [§4](#the-frontends-variables).

### Path B — copy only the package, install from npm

The most basic possible path, and the one CI proves on every push touching the package
(the `clean-room` job in `.github/workflows/ci.yml`, a clean container with no monorepo). Do not do the
copy and the rewrite by hand — `scripts/frontend-clean-room.mjs` **is** the procedure, and it is
the same code the workflow runs:

```sh no-run
pnpm frontend:clean-room --browser
```

It copies `packages/frontend` alone into a temp directory, rewrites its two `workspace:*`
dependencies to published ranges, `npm install`s and runs the package's own `npm run build` (never
`pnpm`, and never `next build` directly — after a plain `npm install` the local binary only
resolves through the npm-run path) **with `NEXT_PUBLIC_API_URL` in the build's environment**, finds
and starts the standalone server the build produced, and requests `/`, `/publishers` and a filtered
`/`. Point it elsewhere with `--api-url <url>` (or the same variable); the default is the
production API.

**`--browser` is the real proof.** The plain HTTP check only sees server-rendered HTML, and the
directory fetches its data from an effect after hydration — so a build whose client-side fetch
cannot reach the API still returns a `200` shell and passes. `--browser` drives a real headless
Chromium and waits for a row to render from a live request. `/publishers` is **not** optional:
whenever the copied source carries that route, a `404` on it is a failure rather than a warning,
with no flag and no workflow input to turn on.

Two flags select the dependency specs, one per package. **The script's own defaults are
`--standard-spec ^3.0.0` and `--validate-spec ^0.3.0`** — the versions that resolve on the registry
today, so a bare `pnpm frontend:clean-room` needs no arguments to reach the install step. Override
either to test a range that is not published yet; an absolute path ending in `.tgz` is used as a
local tarball instead of a registry range.

The defaults are a fact about the registry, not a preference, so they move when the registry does:
publishing 3.1.0 and 0.3.1 is what makes `^3.1.0` / `^0.3.1` the right defaults, and flipping them
is a step of the release ([§7.6](#76-prove-the-next-tag-then-promote)). Until then, passing the
newer ranges by hand is how you test them.

**And until `rfphub-validate` 0.3.1 is published, the default `^0.3.0` fails the build** with a
`TS2305`: the published 0.3.0 tarball predates the `humanizeIssues` export the frontend imports.
That is the one case where the default cannot work, and the way through is a locally built tarball:

```sh no-run
# The Standard FIRST — `rfphub-validate` imports it, and resolves it through its dist. Without
# this line the build fails with TS2307 (cannot find module '@the-rfp-hub/standard').
pnpm --filter @the-rfp-hub/standard build
pnpm --filter rfphub-validate build
pnpm --filter rfphub-validate pack --pack-destination /tmp/rfphub-pack
pnpm frontend:clean-room --browser --validate-spec /tmp/rfphub-pack/rfphub-validate-0.3.0.tgz
```

`pnpm -r build` does the same thing with one line, if you would rather not think about the order.
The dependency direction is why `packages/validate` declares `prepublishOnly: pnpm -w build` — the
same trap, closed for the publish path only.

`pnpm pack`, not `npm pack` — see
[§7.4](#74-inspect-the-tarball-before-every-publish--with-pnpm-pack-never-npm-pack). This whole
note goes away with the release in [§7](#7-npm-release-runbook-manual).

Three things had to change in the package for any of this to work, and all three are in place: the
`tsconfig.json` no longer `extends` a file outside the package, `@types/node` is a declared
devDependency of the package rather than a hoist from the workspace root, and 0.3.1 carries the
missing export.

The canonical-namespace proxies are **apex-only** and need nothing here: with no apex to inherit,
a missing or ordinary `NEXT_PUBLIC_API_URL` produces no rewrites and nothing throws.

### Running the standalone output, whichever path built it

Three things are easy to miss and cost an afternoon each:

* **`NEXT_PUBLIC_API_URL` belongs on the BUILD, not on the run.** It is inlined into the bundle by
  `npm run build`; setting it in front of `node server.js` changes nothing at all, and the page
  renders its "no API configured" state while the variable sits in the process environment looking
  correct. This is the single most common way to lose an afternoon on this package. The clean-room
  script passes it to the build step for exactly this reason.
* **Neither `.next/static` nor `public/` is inside the standalone output.** Next's own
  documentation says so. Copy both to sit beside `server.js`, as `<that directory>/.next/static`
  and `<that directory>/public`. `public/` is the one people skip because it used to be empty; it
  now holds the icons `src/app/manifest.ts` names, and skipping it costs the app icon on every
  installed copy.
* **`server.js` is not at `.next/standalone/server.js` in a stand-alone copy.** The package sets
  `outputFileTracingRoot` two directories above itself — correct in the monorepo, where that is the
  workspace root — and the option is unconditional, so a build from a copy nests the output under
  whatever path Next computed from that root. **Find it rather than assuming**, which is exactly
  what the clean-room script does — **excluding `node_modules`**, because the traced dependencies
  ship `server.js` files of their own and a bare `find` returns several. The app's entry point is
  the only match outside `node_modules`, and it is the one sitting beside a `.next/` directory:

```sh no-run
# The variable goes HERE — on the build.
NEXT_PUBLIC_API_URL=https://api.example.org npm run build

SERVER=$(find .next/standalone -name server.js -not -path '*/node_modules/*')
echo "$SERVER"          # exactly one path. More than one means the -not -path was dropped.
mkdir -p "$(dirname "$SERVER")/.next" && cp -r .next/static "$(dirname "$SERVER")/.next/static"
cp -r public "$(dirname "$SERVER")/public"
node "$SERVER"          # no variable needed here: it is already baked into the bundle
```

### Path C — Docker, over the standalone output

Optional, and worth doing last. A minimal image over the standalone output: `npm install` with the
same dependency rewrite as path B, then `npm run build` **with `NEXT_PUBLIC_API_URL` set as a build
argument** — a runtime `ENV` in the final stage is too late — then run the server the way the
paragraph above describes. Two things to know: **`public/` has to be copied next to `server.js`**,
the same way `.next/static` does — it holds the icons `src/app/manifest.ts` names, and a standalone
build does not carry it, so an image missing that step serves a manifest pointing at five `404`s;
and pnpm's symlinked `node_modules` needs the copy to follow targets (or a prune step) if a build
stage ever touches a pnpm-installed tree.

### The honest limitation: an external copy is read-only

**Sign-in will not work in a copy, and that is expected.** The API's `TRUSTED_ORIGINS` is an exact
allowlist, so the browser's preflight for the sign-in routes is refused from any origin the
deployment has not registered, and there is **no self-service way to add one** — ask the API's
operator. The **public directory works completely**, with no ask required: `/v1` is `origin: "*"`
with `credentials: false`, so browsing, searching, filtering, paging, detail pages and both
link-outs all work.

That is the right trade rather than an unfinished feature. A public directory served from your own
deployment *is* a custom frontend against the public API. Publishing is the apex's job, not every
copy's. If you want sign-in in a copy, ask for your origin to be added to the allowlist — it is a
deployment configuration change on the API side, not a code change on yours.

---

## 10. Where the rest of it is written down

| Question | Document |
|---|---|
| Which variable is a secret, and how does it reach a container? | [`packages/api/docs/deploy.md`](../packages/api/docs/deploy.md) §2 |
| What does each maintenance job do, and when? | [`packages/api/docs/jobs.md`](../packages/api/docs/jobs.md) |
| Who may write, and with which credential? | [`packages/api/docs/auth.md`](../packages/api/docs/auth.md) |
| How do I integrate against the API? | [`api-integration.md`](./api-integration.md) |
| How do I onboard a publisher? | [`publisher-onboarding.md`](./publisher-onboarding.md) |
| What does a reviewer check on one listing? | [`REVIEW-CRITERIA.md`](../REVIEW-CRITERIA.md) |
| How do the MCP server and the agent skill get installed? | [`packages/mcp/README.md`](../packages/mcp/README.md) and [`skills/README.md`](../skills/README.md) |
| What was exposed by the old baked-`.env` path, and what is owed? | [`packages/api/docs/deploy.md`](../packages/api/docs/deploy.md) §7 — treat it as an incident, and rotate before anything else |
