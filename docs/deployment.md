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
| **Environment variables in Vercel**, per environment | `NEXT_PUBLIC_API_URL` is the only one the app requires. It is **inlined at build time**, so which environment's variables `vercel pull` fetches decides which API the shipped bundle talks to |
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

Rate limiting is registered with `global: false`: no route is limited unless it opts in, because a
blanket limit would cap the public read surface this project exists to serve. The routes that do
opt in, and their ceilings:

| Route | Ceiling |
|---|---|
| `POST /v1/opportunities`, `PUT /v1/opportunities/:id`, `POST /v1/opportunities/:id/claim` | 60 / minute |
| `POST /v1/keys` | 10 / minute |
| `DELETE /v1/keys/:id` | 30 / minute |
| `POST /v1/organizations/...` (create), the two member routes | 20–30 / minute |
| `GET /v1/r/:id/apply`, `.../source` | 120 / minute |
| `GET /v1/me` and the review verify route | 20–30 / minute |

**The store is in the process's own memory.** With **N** ECS tasks behind the balancer, every
number above is multiplied by N in practice: "60 a minute" across three tasks is up to 180 a
minute, because a caller's requests land wherever the balancer sends them. A shared store is not
deployed. Write the effective number down — a ceiling the operator believes is one number and is
actually another is worse than none.

A `429` carries `Retry-After`. Metering is per credential where one was proven, and per IP
otherwise — which is the other reason `TRUST_PROXY` is on this list.

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
DATABASE_URL=… pnpm --filter @the-rfp-hub/api grant-admin -- --email you@example.org --create --yes
```

`--create` matters even immediately after sign-in: signing in makes the identity, but the account
row is provisioned lazily on the first authenticated `/v1` request. No environment variable grants
a role, deliberately — a role re-derived from configuration on every request is granted to whoever
holds the configuration and cannot be revoked in the product.

### 5.6 Deploy the frontend

Push (staging) or tag (production). The build inlines `NEXT_PUBLIC_API_URL`, so **redeploy on every
configuration change** — setting the variable on a running host changes nothing.

### 5.7 Verify

```sh no-run
pnpm check:m2 --base-url https://api.example.org --export-url https://data.example.org
```

`check:m2` is read-only: health and TLS, every operation in the *published* OpenAPI document
executed against the *live* service including the strict-`400` negative contract, every served
document validated against the Standard, and the export's freshness and alias-pair invariant.

```sh staging-write
pnpm check:m3 --base-url https://api-staging.example.org --namespace my-org --session-token "$SESSION"
```

`check:m3` **writes** — the publisher lifecycle, the review queue, the audit trail, duplicate
detection, source verification, analytics and the staleness job. It refuses to start without
credentials and a namespace, and refuses a target that does not look like staging unless
`--allow-production` is passed in those words. Everything it creates is prefixed `m3check-` and is
rejected and unlisted at the end.

```sh no-run
pnpm check:m4 --base-url https://api.example.org --site-url https://example.org
```

`check:m4` is read-only and covers the M4 surface: the governance documents and their links from
the site, the public `/publishers` page, the reference frontend's search, filters, paging, detail
and both deep-links, mobile responsiveness, the MCP server being installable and callable, the
published agent skill, and these guides' links and `safe-read` blocks. Its own README sits at `scripts/m4-compliance/README.md`,
beside the M2 and M3 ones.

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

### 7.4 Inspect the tarball before every publish

```sh no-run
npm pack packages/standard
tar -xzOf the-rfp-hub-standard-3.1.0.tgz package/package.json | less
#   version is 3.1.0; `files` carries schemas/, registries/, meta/, ns/, conformance/

npm pack packages/validate
tar -xzOf rfphub-validate-0.3.1.tgz package/package.json | less
#   THE CHECK: "@the-rfp-hub/standard" must read "3.1.0" — never "workspace:*"
tar -tzf rfphub-validate-0.3.1.tgz | grep humanize
#   the export the frontend imports must actually be in the build output
```

The second check is the one that matters. `rfphub-validate` 0.3.0 shipped without `humanizeIssues`
while the source exported it, and an external copy of the frontend failed to typecheck against the
published package as a result. Look inside the tarball, not at the source tree.

### 7.5 Publish

```sh no-run
npm publish packages/standard --access public          # 3.1.0 — FIRST
npm publish packages/validate --access public          # 0.3.1 — after the Standard resolves
npm publish packages/mcp --access public --tag next    # 0.1.0 — never straight to latest
```

Add `--provenance` to each command **if** the publish runs from a CI job with an OIDC identity
registered with the registry. Publishing by hand from a laptop cannot produce provenance — do not
pass the flag there, and do not claim provenance in the README on a release that was cut that way.

### 7.6 Prove the `next` tag, then promote

```sh no-run
npx -y @the-rfp-hub/mcp@next --help
```

```sh no-run
pnpm check:m4 --base-url https://api.example.org --mcp-tag next
npm dist-tag add @the-rfp-hub/mcp@0.1.0 latest        # only after check:m4 is green
```

Nothing is promoted to `latest` on the strength of the publish succeeding. `latest` is what an
unpinned install resolves to, and it is the one decision that cannot be quietly taken back.

### 7.7 The MCP Registry

```sh no-run
cd packages/mcp
mcp-publisher init                 # writes server.json; commit it
mcp-publisher login github
mcp-publisher publish
```

`package.json` must carry the `mcpName` field, and it must match the name in `server.json` — the
registry uses that pairing to confirm the npm package and the registry entry are the same server.

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

---

## 8. Rollback

**The API.** Point the service back at the previous task-definition revision.

```sh no-run
aws ecs update-service --cluster "$CLUSTER" --service rfp-hub-production-service \
  --task-definition rfp-hub-production:<previous-revision>
```

**A revision freezes its configuration along with its image.** Rolling back restores that
revision's environment — including any credential that has been **rotated since**. If a rotation
has happened between the two revisions, the rollback target will authenticate with the old value
and fail; re-deploy forward with the current configuration instead. The deploy workflow deregisters
the revision it replaces for exactly this reason: the copy an immediate rollback would have used is
the copy most likely to hold a superseded secret.

There is one migration in the history with no down-migration: the identity swap is destructive, and
its rollback is *redeploy the previous images and rebuild the database*. That is acceptable only
while no deployment holds identities anybody wants back. It is written here so nobody discovers it
during an incident.

**The frontend.** Push a new `frontend-prod-*` tag pointing at the previous good commit. Rollback
is a git operation, not a console one, so the deployed state stays a fact in the history.

**The export.** Nothing to roll back: every snapshot is an immutable commit, artifacts are named by
digest, and the aliases move forward. Recovering an older dataset is checking out an older commit
of `exports/`.

---

## 9. The frontend: three ways to deploy a copy

The reference frontend is a Next.js app whose **only** required variable is `NEXT_PUBLIC_API_URL`,
inlined at build time. Anyone may deploy their own copy against the public API. Three paths, in
order of how little you need to know:

### Path A — the Deploy Button (clone the repository)

```
https://vercel.com/new/clone?repository-url=https://github.com/The-RFP-Hub/the-rfp-hub&root-directory=packages/frontend&env=NEXT_PUBLIC_API_URL
```

`root-directory=packages/frontend` is a documented Deploy Button parameter, and `repository-url`
deliberately points at the **repository**, not the subdirectory, so the workspace and the lockfile
stay visible to the build. Vercel enables "Include source files outside of the Root Directory" by
default, which is what makes the workspace dependencies resolve. Set `NEXT_PUBLIC_API_URL` when
prompted.

By hand, the same path is: root directory `packages/frontend`, install command
`pnpm install --frozen-lockfile`, build command `pnpm --filter @the-rfp-hub/frontend... build`
(the `...` builds workspace dependencies first).

### Path B — copy only the package, install from npm

The most basic possible path, and the one CI proves on every run
(`.github/workflows/external-deploy-smoke.yml`, a clean container with no monorepo):

```sh no-run
cp -r packages/frontend/ my-directory/ && cd my-directory
# replace the two workspace deps in package.json with published ranges:
#   "@the-rfp-hub/standard": "^3.1.0"
#   "rfphub-validate": "^0.3.1"
npm install
npm run build
NEXT_PUBLIC_API_URL=https://api.example.org node .next/standalone/server.js
```

`scripts/frontend-clean-room.sh` performs the copy and the dependency rewrite, and is what the CI
job runs — read it rather than doing the rewrite by hand.

Three things had to change in the package for this to work at all, and all three are in place: the
`tsconfig.json` no longer `extends` a file outside the package, `@types/node` is a declared
devDependency of the package rather than a hoist from the workspace root, and `rfphub-validate`
0.3.1 actually ships the export the frontend imports.

The canonical-namespace proxies are **apex-only** and need nothing here: with no apex to inherit,
a missing or ordinary `NEXT_PUBLIC_API_URL` produces no rewrites and nothing throws.

### Path C — Docker, over the standalone output

Optional. `output: "standalone"` is set, so a minimal image over `node .next/standalone/server.js`
works. Two things to know: the package has **no `public/` directory**, so a `COPY public/` step
fails; and pnpm's symlinked `node_modules` needs the copy to follow targets (or a `pnpm deploy` /
prune step) or the runtime will be missing modules.

### The honest limitation: an external copy is read-only

**Sign-in will not work in a copy, and that is expected.** The API's `TRUSTED_ORIGINS` is an exact
allowlist, so the browser's preflight for the sign-in routes is refused from any origin the
deployment has not registered. The **public directory works completely**: `/v1` is `origin: "*"`
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
| What was exposed by the old baked-`.env` path, and what is owed? | [`packages/api/docs/deploy.md`](../packages/api/docs/deploy.md) §7 — treat it as an incident, and rotate before anything else |
