# Scheduled jobs — schedule, guarantees and runbook

The maintenance work the request path deliberately does not do: settling yesterday's analytics,
catching up on embeddings and source checks, and closing listings that have stopped being
opportunities.

Everything here is implemented in `src/modules/services/jobs/*`, started by
`scripts/jobs/run-job.ts` (built as `dist/jobs.js`) and scheduled by
`.github/workflows/jobs-nightly.yml`.

---

## 1. The catalogue

| Job | Shape | What it does |
|---|---|---|
| `analytics-rollup` | sweep | Recomputes the last **three** days of `opportunity_stats_daily` from the raw events. |
| `retention` | sweep | Deletes raw events older than `ANALYTICS_RETENTION_DAYS`. |
| `embedding-backfill` | cursor | Embeds entries with no vector for the configured provider, and records the pairs that come out. |
| `verification-backfill` | cursor | Fetches the `applicationUrl` of entries never checked, or edited since their last check. |
| `staleness` | cursor | Closes past-due and long-inactive entries, and recomputes `next_deadline_at`. |

The list lives in exactly one place — `src/modules/services/jobs/registry.ts` — which the runner,
the admin route and this table all read. A name that is not in it is refused by both callers rather
than starting a container task that quietly does nothing.

These names, and the exit codes and `--json` shape that go with them, are what a caller outside this
repository depends on; §4d states that contract in one place.

### Cursor vs sweep, and why the distinction is load-bearing

Every job returns the same `{processed, remaining, skipped?}`. What differs is what `remaining`
means, and getting it wrong is the difference between a job that finishes and one that does not.

* A **cursor** job selects rows by a predicate **the run itself retires**. An embedded entry stops
  matching "has no embedding"; a closed entry stops matching "is open". `remaining` falls, so the
  runner may go round again.
* A **sweep** job deliberately **reprocesses a fixed window every time**. `analytics-rollup`
  re-selects the last three days precisely so that an event written after its own day rolled over —
  a buffer flushing on a timer, a deployment restarting mid-flush — is never permanently missing.
  Its selection never empties, so it reports **`remaining: 0` always**, and that is what stops the
  runner looping it. The rule is structural, not a list of exceptions in the runner: a job that
  reports nothing remaining is not asked again.

The runner's loop condition is `processed > 0 && remaining > 0`, bounded by `--passes`. The
`processed > 0` half matters as much as the other: a row that cannot be embedded, a URL that
refuses every fetch, an account the provider rate-limits — each stays in its predicate, so
`remaining` alone would spin on a poison row forever. A pass that changed nothing is the signal to
stop and let tomorrow's run try again.

### `skipped` has two meanings, and they are kept apart

| Value | Means |
|---|---|
| `locked` | Another run of the **same** job holds the database advisory lock. Added by the runner. |
| anything else | The job's **feature** is not configured — no embedding provider, `VERIFICATION_ENABLED=false`. Reported by the job itself. |

Both exit `0`. Only one of them is a statement about configuration, which is why a runner that
collapsed them would report a permanently unconfigured job as healthy contention.

---

## 2. The schedule, and the ordering it exists to guarantee

**One cron, `5 1 * * *`**, in `.github/workflows/jobs-nightly.yml`. The four independent jobs run in
parallel; **`staleness` runs after them**; and the open-data export
(`.github/workflows/nightly-export.yml`) is triggered by this workflow **completing successfully**.

```
              ┌─ analytics-rollup ──────┐
              ├─ retention ─────────────┤
5 1 * * * ────┼─ embedding-backfill ────┼──> staleness ──(workflow_run: success)──> nightly export
              └─ verification-backfill ─┘
```

**Ordering is a dependency, not a second cron expression.** The export used to run on its own cron
at 03:17, seventeen minutes after staleness was meant to have finished. Scheduled workflows start
late routinely — a busy queue, a maintenance window, a runner shortage — so seventeen minutes
guarantees nothing, and a late maintenance run published a dataset still advertising programmes the
API had already closed. `workflow_run` is the only form of "after" that is actually after.

**What that costs, stated plainly:** a failing job holds tonight's dataset publication, because the
export is gated on the maintenance run succeeding. That is the deliberate trade — publishing a
snapshot whose staleness pass did not run is worse than publishing a day late; the export is
idempotent and the next night republishes; and `workflow_dispatch` on the export recovers it
immediately.

**The export gate is "the SCHEDULED chain succeeded", not "a maintenance run went green".** A
conclusion check alone would be satisfied by two runs that never touched the thing the export
depends on:

* a single-job dispatch — `job=analytics-rollup` skips every staleness step and still concludes
  successfully;
* a `environment=staging` dispatch, which maintains a database the production export never reads.

So `nightly-export.yml` additionally requires `github.event.workflow_run.event == 'schedule'`. The
schedule is the one trigger that always runs the whole chain against production — it leaves `job`
blank and takes the `production` default for `environment`. A partial or staging dispatch therefore
publishes nothing, and `workflow_dispatch` on the export remains the operator's way to say "the
prerequisite is met, publish now".

### Which deployment a run maintains

`environment` is a required `workflow_dispatch` input (`production` | `staging`) and is **empty on
the schedule, which means `production`** — the deployment the open-data export reads. The AWS
credential and the cluster are selected from that name:

| Environment | Credentials | Cluster |
|---|---|---|
| `production` (and every scheduled run) | `PRODUCTION_AWS_ACCESS_KEY_ID` / `PRODUCTION_AWS_SECRET_ACCESS_KEY` — the same pair `production.yml` deploys with | `PRODUCTION_ECS_CLUSTER` — the same variable |
| `staging` (dispatch only) | `STAGING_AWS_ACCESS_KEY_ID` / `STAGING_AWS_SECRET_ACCESS_KEY` | `STAGING_ECS_CLUSTER` |

The lookups are `secrets[format(...)]` / `vars[format(...)]` **index** expressions rather than the
`&&`/`||` fallback idiom: a fallback treats an unset staging variable as false and silently reaches
for the production cluster, which is the exact accident this parameterisation exists to prevent. An
unset variable stays unset and `run-ecs-job.sh` names it, with the environment in the message.

### What the runner uses, and what it therefore does not need

**A job is the deployed image with a different command**, so it runs on the API **service's own
task definition** and inherits everything already assembled there — the image, the runtime
`DATABASE_URL`, every key of the `secrets:` array, the execution and task roles. Nothing about a
job is different except `command`, which `run-ecs-job.sh` supplies as a container override.

Everything else is derived from the names the deploy workflows already hardcode, or discovered at
run time:

| What | Where it comes from |
|---|---|
| Cluster | `<ENV>_ECS_CLUSTER` — **the only repository variable**, and the deploy workflow for that environment already requires it |
| Task definition family, container name | `rfp-hub-<env>`, derived in `run-ecs-job.sh` (overridable via `ECS_TASK_DEFINITION` / `ECS_CONTAINER`) |
| Service | `rfp-hub-<env>-service`, likewise (`ECS_SERVICE`) |
| Launch type / capacity provider strategy | **read from the service** with `aws ecs describe-services`, and reused verbatim |
| Placement constraints | **read from the service** and reused verbatim on the EC2 path, so a job cannot land on capacity the API is deliberately kept off. Fargate neither accepts nor can have them |
| Subnets, security groups, `assignPublicIp` | **read from the service** (`services[0].networkConfiguration.awsvpcConfiguration`) when the task definition is `awsvpc`; a `bridge` or `host` deployment has none, and the job runs without them |
| `networkMode`, `requiresCompatibilities` | **read from the task definition** with `aws ecs describe-task-definition` on the same family the deploy workflow already describes |

**A non-awsvpc deployment carries one requirement, and it is the operator's to meet.** A job is a
SECOND task from the service's own task definition, running while the service is up. Under
`networkMode: host` — or `bridge` with a **fixed** `hostPort` — the service already reserves that
port on every instance it is eligible for, so a second task wanting the same port is unplaceable on
all of them. Nothing in the runner can resolve that: the task definition is the service's, and the
port is in it. So either the task definition uses a **dynamic host port** (`hostPort: 0`, which is
the ordinary bridge-mode choice and lets both tasks coexist), or there is **spare eligible capacity**
the constraint expression still admits. `awsvpc` and Fargate deployments are unaffected — each task
gets its own interface, so there is no reservation to collide with.

The symptom when it is not met is a **placement** failure, not an application error, and it reads
like an outage until somebody knows otherwise — so `run-ecs-job.sh` names this cause explicitly when
a stopped task's `stoppedReason` mentions a resource or a port.

The network configuration is discovered rather than configured for the same reason the task
definition is reused: restating the VPC layout in repository variables is asking an operator to
keep a copy of it in sync by hand, and a stale copy starts the job in a subnet that cannot reach the
database. Reading the service means **the job lands exactly where the API lands, by construction**.

**`awsvpc` is not required.** `awsvpcConfiguration` exists only when the task definition's
`networkMode` is `awsvpc`; a service whose tasks use `bridge` or `host` — the ordinary shape of an
EC2 launch type — has none, and ECS *rejects* `--network-configuration` for one. So the runner
describes the task definition too and lets `networkMode` decide the shape of the `run-task` call:
`awsvpc` reuses the service's configuration, anything else omits the flag and keeps only the
placement. The only combination treated as unprovisioned is an `awsvpc` task definition whose
service states no network configuration — a service that cannot have been deployed.

There is consequently **no maintenance task definition to provision** and no second copy of the
secret list to keep in step with the service's.

---

## 3. Idempotency and locking

**Every job is safe to run twice.** Not "unlikely to be run twice" — safe:

* `analytics-rollup` **assigns** `count(*)` for a day, never `existing + n`. An increment is only
  correct if the job runs exactly once per day forever, and the first retry, the first manual run
  and the first overlapping schedule each silently double a publisher's numbers with nothing about
  the result looking wrong.
* `staleness` closes only entries that are still `open`, re-checking under a row lock inside the
  transaction, so a publisher's edit racing the walk wins. A second run finds nothing to close and
  writes no second audit row.
* `embedding-backfill` and `verification-backfill` select on the absence of the thing they produce.

**Concurrency is excluded by `pg_try_advisory_lock`, taken on a dedicated connection.** Three
decisions, each closing something real:

1. **`try`, not the blocking form.** `pg_advisory_lock` *waits* — it cannot report contention, so a
   second run queues behind the first and starts the moment it ends, which is the opposite of
   skipping. The `try` form returns a boolean, and `false` becomes `{skipped: "locked"}` and exit 0.
2. **A dedicated `pg.Client`, never the pool.** A session-level advisory lock belongs to the
   *connection* that took it. Through a pool, the unlock can be issued on a different connection —
   which silently does nothing and holds the lock until that connection is recycled.
3. **Unlock and disconnect in `finally`.** A throwing job must not leave the lock behind.

The key is derived from the job's **name**, so `staleness` excludes another `staleness` across
processes, hosts and container tasks, and two different jobs run concurrently quite happily.

### What staleness deliberately does not touch

`updated_at`. Two things read it, and both break if a maintenance pass moves it: this job's own
inactivity clock is `coalesce(last_seen_at, updated_at)`, so bumping it would reset the timer that
selected the row; and the verification job's predicate is `verified_at < updated_at`, so bumping it
would re-queue every closed entry for an outbound fetch, every night, forever. The audit row
carries the time of the change, which is where that fact belongs.

---

## 4. Triggers — the three ways a job starts

### a. The schedule (how it actually runs)

`.github/workflows/jobs-nightly.yml` starts each job as a **one-off ECS task on the API service's
own task definition**, using the AWS credentials the deploy workflows already hold. Read the service
to learn where it runs and the task definition to learn what shape it is, then start that task
definition there with a different command.

```sh
# where the API runs — its own placement and, on awsvpc only, its subnets and security groups
svc=$(aws ecs describe-services --cluster "$CLUSTER" --services rfp-hub-<env>-service)
vpc=$(jq -c '.services[0].networkConfiguration.awsvpcConfiguration // empty' <<<"$svc")
# what shape it is — awsvpc takes a --network-configuration, bridge and host REJECT one
mode=$(aws ecs describe-task-definition --task-definition rfp-hub-<env> \
        --query 'taskDefinition.networkMode' --output text)

# placement comes from the service, never a literal: FARGATE cannot run a bridge/host task
args=(--launch-type "$(jq -r '.services[0].launchType' <<<"$svc")")
[ "$mode" = awsvpc ] && args+=(--network-configuration "$(jq -nc --argjson vpc "$vpc" '{awsvpcConfiguration: $vpc}')")

aws ecs run-task --cluster "$CLUSTER" --task-definition rfp-hub-<env> "${args[@]}" \
  --overrides '{"containerOverrides":[{"name":"rfp-hub-<env>","command":["node","packages/api/dist/jobs.js","staleness","--json"]}]}'
```

That is the sketch. `run-ecs-job.sh` is the same two calls plus the cases a sketch omits: a service
on a **capacity provider** reports no `launchType` and needs `--capacity-provider-strategy` instead,
and every branch that declines prints what it read first.

**There is no public job endpoint and no shared job token.** A credential that can start a job has
to live somewhere, and "a token in repository secrets that the internet-facing API accepts forever"
is a worse somewhere than the deploy role that already exists.

`.github/scripts/run-ecs-job.sh` is what does it, and it answers the *unprovisioned* case two ways
on purpose. Two things can be absent — the cluster variable, and the service itself — and on the
schedule either is a loud `::warning::` and a green job (the export is chained to this workflow, and
failing over a resource that has never existed would stop the dataset publishing), while on a
`workflow_dispatch` either **fails**, because an operator dispatching the run is asking whether the
wiring works.

Before it declines it **prints what it read** — the `failures` array, the service's status, launch
type, capacity provider strategy and task definition ARN, and that task definition's `networkMode`
and `requiresCompatibilities` — and the message names which case it is: *service missing (failures:
…)* or *service present but states no awsvpc network configuration*. The two look identical from
outside and have completely different fixes, and the log is all an operator has a night later.

### b. The image, or a checkout (an operator, by hand)

```sh
# inside the deployed image
node packages/api/dist/jobs.js staleness --json

# locally, against a database you own
DATABASE_URL=… pnpm --filter @the-rfp-hub/api jobs staleness
DATABASE_URL=… pnpm --filter @the-rfp-hub/api jobs embedding-backfill --limit 100 --passes 5
pnpm --filter @the-rfp-hub/api jobs --help
```

Exit codes: `0` ran or declined · `1` the job threw · `2` the invocation was wrong.

### c. `POST /v1/admin/jobs/{job}/run` (a reviewer, from the dashboard)

A **signed-in administrator session only** — an API key is refused with `403 session_required`,
because a global role never elevates an API key. It runs **exactly one pass**: a request that
looped a cursor job to exhaustion would hold a connection and a socket for as long as the backlog
took, and the thing allowed to take that long is the container task. It takes the same advisory
lock, so pressing it while the scheduled run is in flight answers `skipped: "locked"`.

### d. Running from an external scheduler

A job may also be started by **an external scheduler such as a workflow orchestrator**, outside this
repository, as a one-off container task on the deployed image. Nothing about the job changes when it
is; what such a caller depends on is stated here so it does not have to be inferred from the runner,
and so it does not quietly stop being true.

**The entry point is the image's, and the argv is the whole interface.**

```sh
node packages/api/dist/jobs.js <job> --json
```

`<job>` is one of the five names in §1 — the catalogue in
`src/modules/services/jobs/registry.ts` is the one place a name is spelled, and a name that is not
in it exits `2` rather than doing nothing. `--limit` and `--passes` are available and job-specific;
neither is required.

**It runs on the API service's own task definition**, as a container command override and nothing
else. The image, the runtime `DATABASE_URL`, every key of the `secrets:` array, the execution and
task roles are already assembled there and the deploy workflows keep them current — so an external
caller supplies **no additional environment**, and must not, because a second copy of that list is a
copy that goes stale in exactly the way that matters.

**Exit codes are the contract**, and they are the same for every caller:

| Code | Means |
|---|---|
| `0` | The job ran, **or declined** — another run held the lock, or its feature is not configured |
| `1` | The job threw |
| `2` | The invocation was wrong — an unknown job name, or a bad flag |

**A missing `DATABASE_URL` is `1`, not `2`.** `src/config.ts` refuses to load without one under
`NODE_ENV=production` — it exits `1` at **module load**, before the entry point's own argument
handling runs, precisely so a production process can never silently fall back to a localhost
database. The entry point's `DATABASE_URL` check is therefore reached only off the production path,
where an unset variable takes the announced localhost default rather than failing. A caller should
read `1` as "this run did not do its work" without assuming the job itself was entered.

A run that declined is deliberately a **zero**. A scheduled task that correctly did not start
because the previous one is still going has not failed, and paging somebody about it teaches
everybody to ignore the alert.

**`--json` writes exactly one object to stdout**, on one line:

```json
{"job":"staleness","shape":"cursor","processed":12,"remaining":0,"passes":2,"elapsedMs":3410}
```

`skipped` is present **only** when the job did not do its work, and carries which of the two reasons
it was — `"locked"`, or the name of the unconfigured feature (§1). `details` is a free-form object
of per-job counters. Both keys are absent rather than null when they do not apply, so a caller
should treat `job`, `shape`, `processed`, `remaining`, `passes` and `elapsedMs` as always present
and the other two as optional.

**The lock makes overlap safe against double writes. It does NOT make overlap safe.** Every job
takes a `pg_try_advisory_lock` keyed on **its own name**, in the database — the only thing every
runner shares — so exclusion holds across processes, hosts, container tasks and repositories, and
the second run to arrive does not wait: it reports `{"skipped":"locked"}` and exits `0` immediately
(§3). That is a guarantee about **data integrity within one job**, and it is the whole of what the
lock provides.

**It is not a guarantee about the chain**, because the locks are per job and the chain's ordering is
between *different* jobs — which never exclude each other. Two schedulers running the chain in
overlapping windows can therefore interleave, and the interleaving loses work while every single run
reports success:

> Scheduler A is partway through `verification-backfill`. Scheduler B starts its own chain, finds
> that job locked, correctly reports `skipped: "locked"`, exits `0` — and moves on to `staleness`,
> which now runs **before** A's verification pass has finished. A successful check is a "still real"
> signal that **resets the staleness clock** (`verification.service.ts` writes `lastSeenAt` on a
> match), and staleness's inactivity test is `coalesce(last_seen_at, updated_at)`. So entries A was
> about to prove active are closed as long-inactive instead. A's verification finishes a minute
> later and does **not** reopen them — it never writes `status`, and staleness only ever closes rows
> that are still `open`. Both chains are green. The dataset is wrong.

**So the ordering requirement is the caller's, and the rule is: the chain must not run in two
overlapping windows.** One of the following has to hold, and which one is an operator's choice:

* the **external scheduler owns the whole chain** and the GitHub cron is disabled — comment out the
  `schedule:` trigger in `jobs-nightly.yml`, leaving it `workflow_dispatch`-only; **or**
* the external run is scheduled to **finish before the nightly chain starts**, with enough margin
  for a slow pass. `5 1 * * *` is the nightly cron, and scheduled workflows start *late*, never
  early — so the margin only has to cover the external run's own worst case.

Within a chain the requirement is the one §2 states: **`staleness` runs after the other four**,
because it closes past-due and long-inactive entries and everything downstream must observe that
state rather than the state before it. Running the five serially with `staleness` last satisfies it;
running them in parallel does not.

**An external run does not publish the open-data dataset.** The export is triggered by
`.github/workflows/nightly-export.yml` on the **scheduled** run of `jobs-nightly.yml` completing
successfully (§2), and by nothing else — not a dispatch of that workflow, and not a job started from
outside GitHub Actions. So the nightly chain remains the gate: it still has to run, and still has to
succeed, or the day's snapshot is not published. An external schedule is **additional** maintenance,
never a replacement for the chain the export hangs off.

---

## 5. Prerequisites and the migration runbook

Jobs run against the same schema the service does, so **the migrations must be applied first** —
`embedding-backfill` writes a `vector(1536)` column that does not exist until they are, and
`CREATE EXTENSION vector` ships as a checked-in migration (`0002_pgvector_extension.sql`) that a
managed instance may refuse.

Before the first M3 job run on any deployment, in order:

1. Confirm the extension is permitted — `SHOW rds.extensions;` must list `vector`. It is a property
   of the engine version and the parameter group and is **not recorded in this repository**. See
   [`deploy.md` §4](./deploy.md).
2. Apply the migrations with the **DDL-capable** credential:
   `node packages/api/dist/migrate.js` — see [`deploy.md` §5](./deploy.md).
3. Deploy the API to that environment at least once, so `rfp-hub-<env>` and
   `rfp-hub-<env>-service` exist and `<ENV>_ECS_CLUSTER` is set. Both are prerequisites of the
   deploy workflow itself, so this is nearly always already true; the runner reads the service for
   its launch type — and, on an `awsvpc` deployment, its subnets and security groups — and prints
   everything it read when the service is not there yet.
4. Grant the deploy IAM user **`ecs:RunTask` on the task definition and `iam:PassRole` for the
   task's execution and task roles**. This is the one permission that may be missing: registering a
   task definition and updating a service — which the deploy workflow already does — does not imply
   the right to start a task from it. `ecs:DescribeServices` and `ecs:DescribeTaskDefinition` are
   already exercised by the deploy workflow with the same credential. Nothing else is needed; the
   maintenance chain uses the **runtime** credential inside the container, not a DDL one.
5. Prove it with one `workflow_dispatch` of *Nightly maintenance jobs* per environment, which fails
   loudly if the cluster variable is unset or the service cannot be described. A dispatch does
   **not** trigger the export (only the scheduled chain does), so confirm the export separately —
   either wait for one scheduled run or dispatch *Nightly open-data export* directly.

---

## 6. Configuration each job reads

| Job | Variables |
|---|---|
| `analytics-rollup` | none. It reads whatever `opportunity_events` holds, so `ANALYTICS_ENABLED=false` makes it a no-op by starvation rather than by a flag |
| `retention` | `ANALYTICS_RETENTION_DAYS` (default 180) |
| `embedding-backfill` | `EMBEDDING_PROVIDER`, `DEDUPE_SIMILARITY_THRESHOLD`, `DEDUPE_MAX_MATCHES` |
| `verification-backfill` | `VERIFICATION_ENABLED`, `VERIFY_TIMEOUT_MS`, `VERIFY_MAX_BYTES`, `VERIFIER_EGRESS_PROXY` |
| `staleness` | `STALENESS_INACTIVE_DAYS` (default 90) |

After a **model-string change** (a new featurizer weighting or a refreshed idf table), every stored
vector is stale by content-hash design and `embedding-backfill`'s first pass selects the whole
table — run it to `remaining: 0` in the same maintenance step as the deploy. Until the drain
finishes, NEW detection is degraded but not wrong (`search()` filters on the current model, so
old-space vectors are invisible rather than incomparable) — while PAIRS RECORDED BY THE OLD SPACE
remain visible in the review queue as they stand, because a suspected pair carries no model of its
own: each is re-judged, and pruned if unalike, only when one of its entries is re-embedded. The
drain is what retires them.

`VERIFY_ALLOW_PRIVATE_HOSTS` is **never set in any deployed task definition**, including the
maintenance one. It is a test-only SSRF escape hatch and the process refuses to boot with it enabled
under `NODE_ENV=production`.

---

## 7. What a job writes to the audit trail

Every mutation a job makes is an `audit_log` row with `actor_kind='job'`,
`actor_account_id = NULL` and `actor_api_key_id = NULL`, in the **same transaction** as the
mutation. The patch names the job and its reason:

```json
{ "job": "staleness", "reason": "past_due", "status": { "before": "open", "after": "closed" } }
```

`reason` is `past_due` or `inactive`, and it is the difference between "this programme's deadline
has passed" and "nobody has re-asserted this listing in ninety days" — which are different things to
tell a publisher. The public trail shows the changed field names and the actor `job`; the entry's
submitter, its publisher and T3+ see the full patch.
