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
| `PRIVY_APP_SECRET` | `PRIVY_APP_SECRET` | Server-side app secret. Optional: only account enrichment uses it, and enrichment is off the authentication path |
| `PRIVY_VERIFICATION_KEY` | `PRIVY_VERIFICATION_KEY` | The app's PEM verification key. Public-key material, but treated as a secret so it cannot be swapped by anyone who can read a task definition — swapping it swaps who can log in |
| `OPENAI_API_KEY` | `OPENAI_API_KEY` | Embedding provider credential. Absent → the deterministic provider, and dedupe reports itself unavailable rather than failing a submission |
| `ANALYTICS_HMAC_KEY` | `ANALYTICS_HMAC_KEY` | Keys the session/IP HMAC. **Never baked**: a leaked key makes the whole IPv4 space brute-forceable against the stored hashes. Unset → a random per-boot key and a warning |

### Non-secret settings → `environment`

| Variable | Typical deployed value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Also what makes `VERIFY_ALLOW_PRIVATE_HOSTS` refuse to boot |
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
| `BOOTSTRAP_ADMIN_PRIVY_DIDS` | comma-separated DIDs | Re-evaluated on **every** login, so adding one later takes effect without a redeploy |
| `BOOTSTRAP_ADMIN_WALLETS` | comma-separated addresses | Matched only against a **verified** wallet from enrichment. Inert without `PRIVY_APP_SECRET`, and the API says so at boot |
| `PRIVY_APP_ID` | the app id | Not secret — it is the token audience, and it is published to the browser by the dashboard |
| `PRIVY_JWKS_URL` | unset | An **unverified** override. The documented mechanism for app access tokens is the PEM above |

Use a **separate identity-provider application per environment** — development, staging and
production each with their own — so a token minted for one environment cannot authenticate against
another, and so the user records stay isolated.

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

---

## 6. Running the maintenance jobs

The nightly maintenance work runs as **one-off tasks on the same image**, started by
`.github/workflows/jobs-nightly.yml` with the credentials the deploy workflows already hold:

```sh
node packages/api/dist/jobs.js <job> --json      # inside the image
```

There is **no public job endpoint and no shared job token**, deliberately: a credential that can
start a job has to live somewhere, and a token in repository secrets that the internet-facing API
accepts forever is a worse somewhere than the deploy role that already exists.
`POST /v1/admin/jobs/{job}/run` is a signed-in administrator's convenience, not a machine
credential.

### Operator prerequisites

One set **per environment**: `<ENV>` is `PRODUCTION` or `STAGING`, and the workflow picks the set
from its `environment` input — which is empty on the schedule and therefore `production`, matching
the deployment the open-data export reads. The credentials are picked the same way
(`<ENV>_AWS_ACCESS_KEY_ID` / `<ENV>_AWS_SECRET_ACCESS_KEY`), so a scheduled maintenance chain
authenticates exactly as `production.yml` does.

| Repository variable | What it names |
|---|---|
| `<ENV>_MAINTENANCE_ECS_CLUSTER` | The cluster the one-off task runs in |
| `<ENV>_MAINTENANCE_ECS_TASK_DEFINITION` | A task definition on the deployed image, with the **runtime** `DATABASE_URL` — never the DDL role |
| `<ENV>_MAINTENANCE_ECS_CONTAINER` | The container name inside it, for the command override |
| `<ENV>_MAINTENANCE_ECS_SUBNETS` | Comma-separated subnet ids with egress (the verification job makes outbound requests) |
| `<ENV>_MAINTENANCE_ECS_SECURITY_GROUPS` | Comma-separated security group ids |

Until all five of an environment's variables are set, the scheduled run announces a `::warning::`
and stays green — the open-data export is chained to that workflow, and failing over a resource that
has never existed would stop the dataset publishing. A **manual `workflow_dispatch` fails instead**,
so an operator validating the wiring gets a real answer, and the message names the environment
whose variables are missing. Prove it with one dispatch per environment before relying on the
schedule.

The task definition may reuse the service's `secrets` and `environment` verbatim. The full
schedule, the idempotency and locking guarantees, and the per-job configuration are in
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
