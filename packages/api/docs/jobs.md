# Scheduled jobs — schedule, guarantees and runbook

The background work the request path deliberately does not wait for: settling yesterday's
analytics, catching up on embeddings and source checks, closing stale listings, and sweeping
durable notification email that the API's immediate in-process trigger missed.

Everything here is implemented in `src/modules/services/jobs/*` and started by
`scripts/jobs/run-job.ts` (built as `dist/jobs.js`). The nightly chain is **scheduled outside this
repository** (§2), and this repository holds no maintenance workflow at all: every path in §4
reaches the same entry point. Notification email also has a bounded post-commit trigger in the API
process; it calls the same dispatcher for the newly inserted row ids without invoking a job.

---

## 1. The catalogue

| Job | Shape | What it does |
|---|---|---|
| `analytics-rollup` | sweep | Recomputes the last **three** days of `opportunity_stats_daily` from the raw events. |
| `retention` | sweep | Deletes raw events older than `ANALYTICS_RETENTION_DAYS`. |
| `embedding-backfill` | cursor | Embeds entries with no vector for the configured provider, and records the pairs that come out. |
| `verification-backfill` | cursor | Fetches the `applicationUrl` of entries never checked, or edited since their last check. |
| `staleness` | cursor | Closes past-due and long-inactive entries, and recomputes `next_deadline_at`. |
| `notification-dispatch` | cursor | Joins pending notification accounts to `auth_user`, composes duplicate-domain copy, and sends it through the central email service. |

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
| anything else | The job's **feature** is not configured — no embedding provider, `VERIFICATION_ENABLED=false`, or no delivering email transport. Reported by the job itself. |

Both exit `0`. Only one of them is a statement about configuration, which is why a runner that
collapsed them would report a permanently unconfigured job as healthy contention.

---

## 2. The schedule, and the ordering it exists to guarantee

**One schedule owns the whole chain, and it is not in this repository.** An external scheduler runs
the six jobs at **01:05 UTC**. They carry **one ordering rule** between them: the five below are
independent and may run in any order or in parallel; `staleness` runs **after all of them**.

```
UTC
01:05  external scheduler ──┬─ analytics-rollup ──────┐
                            ├─ retention ─────────────┤
                            ├─ embedding-backfill ────┤  independent of each other:
                            ├─ verification-backfill ─┤  any order, or in parallel
                            └─ notification-dispatch ─┘
                                       │
                                       └──> staleness   ← after ALL five, always

03:17  nightly-export.yml     publishes the dataset — its OWN cron, not chained (see below)
```

Running the six one at a time satisfies that rule; so does running the five together and
`staleness` when the last of them exits. The rule is the contract (§4d); serialising is one way to
meet it.

**This repository schedules nothing, and no longer dispatches anything either.** There is no
maintenance workflow here: the external scheduler is the only caller that runs nightly, and the
manual path is an operator starting the same one-off task by hand (§4a) — a recovery after a failed
external run, or a check that the wiring works.

**Why `staleness` is last, and why one caller.** The advisory lock each job takes excludes a job
from **itself**, never one job from another (§3). So two callers whose windows overlap do not
double-write — but they do interleave, and `staleness` running while `verification-backfill` is
still going closes entries that a successful check was about to keep open, with **both runs
reporting success** (§4d has the walk-through). Putting `staleness` after everything, under a single
caller, is what prevents that: a successful check writes `lastSeenAt`, and staleness reads that
state after it has settled instead of underneath it. The other five write nothing each other reads,
which is why they carry no ordering at all.

There is no notification-only cron or workflow. Normal delivery starts immediately after the
notification transaction commits; the chain's `notification-dispatch` node is the daily backstop,
under the same per-name advisory lock as every other job. An expected email-provider refusal is
stamped on the notification and returned as a successful job result, so provider availability alone
does not fail the chain.

**The open-data export is NOT chained to the maintenance work.** `nightly-export.yml` runs on its
own cron, `17 3 * * *`. Nothing triggers it — not this repository, not the external scheduler — and
a failed maintenance job does not hold it back. Ordering between the two is **by clock alone**,
which is a weaker guarantee than a dependency and is written down plainly here because it is easy
to assume otherwise: the chain has just over two hours of margin, and the export publishes at 03:17
whatever state it is in.

**What that costs, stated plainly:** a scheduled run can start late, run long or fail, and the
clock cannot notice. A chain that fails or never starts is not observed by the export, which
publishes on time regardless; the dataset then advertises programmes the API would have closed. The
snapshot reflects the staleness pass from earlier the same night, so an entry that falls past-due
after that pass is published as open and corrected the following night. The export is idempotent and
`workflow_dispatch` on it republishes immediately once the cause is fixed. **Monitor the external
run on its own** — nothing downstream will report its absence for you.

> **Not enforced.** Nothing makes the export wait for the chain to finish. An actual "after" would
> mean the external scheduler starting `nightly-export.yml` as its last step and that cron coming
> off. It is **not wired**. Deciding it is an owner's call, not this document's — until then the
> two-hour margin is the whole of the guarantee.

### Which deployment a run maintains

**The nightly chain maintains production** — the deployment the open-data export reads. That is a
property of the external scheduler, which is where the environment is chosen; nothing in this
repository selects it.

A manual run (§4a) maintains whichever deployment the operator names on the command line, and the
names come in threes that must not be mixed:

| Environment | Cluster | Task definition family | Service |
|---|---|---|---|
| `production` | the production cluster | `rfp-hub-production` | `rfp-hub-production-service` |
| `staging` | the staging cluster | `rfp-hub-staging` | `rfp-hub-staging-service` |

The cluster is the hosting account's own resource name rather than a fact about this project, so it
is not written down here (see `scripts/check-neutral.mjs`); it is the same value the deploy workflow
for that environment already reads from a repository variable. Half a pair is the accident worth
naming: production credentials against a staging cluster fail outright, but a **staging** profile
pointed at the production service quietly maintains the wrong database. Say the environment out
loud, in all three names and in the credential profile, every time.

### What a run uses, and what it therefore does not need

**A job is the deployed image with a different command**, so it runs on the API **service's own
task definition** and inherits everything already assembled there — the image, the runtime
`DATABASE_URL`, every key of the `secrets:` array, the execution and task roles. Nothing about a
job is different except `command`, supplied as a container override.

Everything else is a name the deploy workflows already hardcode, or is discovered at run time:

| What | Where it comes from |
|---|---|
| Cluster | The environment's cluster — the same repository variable the deploy workflow for it already requires |
| Task definition family, container name | `rfp-hub-<env>` — the family the deploy workflow registers |
| Service | `rfp-hub-<env>-service` |
| Revision | The one the **service is actually running**, read off `describe-services` — not the family name, which resolves to the latest `ACTIVE` revision and can be one whose deploy failed |
| Launch type / capacity provider strategy | **read from the service** with `aws ecs describe-services`, and reused verbatim |
| Placement constraints | **read from the service** and reused verbatim, so a job cannot land on capacity the API is deliberately kept off |
| Network configuration | **none.** The deployment runs EC2 with `bridge` networking: no `--network-configuration` is passed, and none is needed |

Placement is discovered rather than configured for the same reason the task definition is reused:
restating it in repository variables is asking an operator to keep a copy in sync by hand, and a
stale copy starts the job on capacity the API is deliberately kept off. Reading the service means
**the job lands exactly where the API lands, by construction**.

**One requirement comes with that, and it is the operator's to meet.** A job is a SECOND task from
the service's own task definition, running while the service is up. With a **fixed** `hostPort`, the
service already reserves that port on every instance it is eligible for, so a second task wanting
the same port is unplaceable on all of them. Nothing in the runner can resolve it: the task
definition is the service's, and the port is in it. So either the task definition uses a **dynamic
host port** (`hostPort: 0`, the ordinary bridge-mode choice, which lets both tasks coexist), or
there is **spare eligible capacity** the constraint expression still admits.

The symptom when it is not met is a **placement** failure, not an application error, and it reads
like an outage until somebody knows otherwise: a task that stops with a `stoppedReason` naming a
resource or a port has not crashed, it never started.

There is consequently **no maintenance task definition to provision** and no second copy of the
secret list to keep in step with the service's.

---

## 3. Idempotency and locking

**Every job is safe to run twice.** Not "unlikely to be run twice" — safe. Read that as
*sequentially*: run a job, let it finish, run it again, and nothing is double-counted or double-sent.
Two runs **overlapping in time** are a different claim, and the advisory lock below is what supplies
it — but only against another run of the **same job name**. Nothing stops a different caller from
touching the same rows, which is why `notification-dispatch` does not rely on the lock alone.

* `analytics-rollup` **assigns** `count(*)` for a day, never `existing + n`. An increment is only
  correct if the job runs exactly once per day forever, and the first retry, the first manual run
  and the first overlapping schedule each silently double a publisher's numbers with nothing about
  the result looking wrong.
* `staleness` closes only entries that are still `open`, re-checking under a row lock inside the
  transaction, so a publisher's edit racing the walk wins. A second run finds nothing to close and
  writes no second audit row.
* `embedding-backfill` and `verification-backfill` select on the absence of the thing they produce.
* `notification-dispatch` selects rows without `email_dispatched_at`. A successful send stamps it,
  so a normal second run sends nothing. Transport failures retry at most three total attempts, no
  sooner than five minutes after the completion of the last attempt — including retries within one
  long sweep run; an account with no identity email is a terminal `recipient_unavailable` failure
  rather than a poison row retried forever.
  **It also leases every row it is about to send, in the selecting statement itself** — a single
  `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *` that counts the attempt and
  stamps `email_failed_at` before any mail leaves. That is deliberately more than the job lock
  gives: this job's rows are also dispatched by the API process's in-process queue at event time, so
  the two can be in flight at once by design and only a row-level claim separates them. The visible
  consequence is that a dispatcher that dies mid-send **burns one of the row's three attempts**
  rather than leaving it in flight forever; the payload records that attempt as `in_flight`, meaning
  nothing ever observed how it ended.
  The lease also carries an **owner token**, because a deadline on its own is a promise the sender
  cannot keep: rows are sent serially, so a long batch — or one hung provider call — can outlive the
  five-minute floor while the dispatcher is still holding the row. The token is renewed immediately
  before each send and is a condition of every stamp, so a dispatcher that has lost the row finds
  out by matching no rows, sends nothing and writes nothing (reported as `leaseLost`). The
  complementary half is on the transports: `ses` and `resend` now abandon a single call after 30
  seconds, as `mailgun` already did, so no one send can outlive the floor to begin with.

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

### Immediate notification trigger

Duplicate detection and review mutations insert notifications inside their own database
transactions. Only after such a transaction commits, its newly inserted notification ids are handed
to the API process's fire-and-forget dispatcher. The queue is serial, retains at most
`NOTIFICATION_QUEUE_MAX` waiting ids (100 by default), and rejects the newest id when full. Enqueue
never waits for email and worker errors never propagate to the response.

The worker calls `NotificationDispatchService` with exactly one queued id. It makes one best-effort
attempt; it does not run the job loop or retry in memory. A transport failure stamps durable retry
state, while queue overflow or process loss leaves the row unstamped. If the configured transport
does not deliver, the service returns the same `email delivery is not configured` skip as the job.
All of those states remain visible to the nightly unscoped sweep.

### What staleness deliberately does not touch

`updated_at`. Two things read it, and both break if a maintenance pass moves it: this job's own
inactivity clock is `coalesce(last_seen_at, updated_at)`, so bumping it would reset the timer that
selected the row; and the verification job's predicate is `verified_at < updated_at`, so bumping it
would re-queue every closed entry for an outbound fetch, every night, forever. The audit row
carries the time of the change, which is where that fact belongs.

---

## 4. Triggers — the four ways a job starts

* **The external scheduler** — the primary one, and the only thing that runs nightly. The contract
  it depends on is (d).
* **A one-off ECS task, started by hand** — an operator, for staging or an emergency (a).
* **`POST /v1/admin/jobs/{job}/run`** — a reviewer, one pass, from the dashboard (c).
* **The image or a checkout** — by hand, locally or inside the container (b).

### a. A one-off ECS task, started by hand (an operator)

**This repository has no maintenance workflow.** The Actions dispatch that used to exist is gone
along with the chain's schedule: the external scheduler runs the six nightly, and an operator who
needs a job run outside that — staging, or a recovery after a failed external run — starts the same
one-off task directly. It is **two calls**: read the service to learn where the API runs, then start
its task definition there with a different command.

```sh
# 1. where the API runs — its own revision and placement, to be reused verbatim
svc=$(aws ecs describe-services --cluster "$CLUSTER" --services rfp-hub-<env>-service)

# 2. the same task definition, one different command
aws ecs run-task --cluster "$CLUSTER" \
  --task-definition "$(jq -r '.services[0].taskDefinition' <<<"$svc")" \
  --launch-type "$(jq -r '.services[0].launchType' <<<"$svc")" \
  --overrides '{"containerOverrides":[{"name":"rfp-hub-<env>","command":["node","packages/api/dist/jobs.js","staleness","--json"]}]}'
```

Three things about those two calls are the point rather than the ceremony:

* **The revision comes from the service**, not from the family name — `run-task` would resolve
  `rfp-hub-<env>` to the latest `ACTIVE` revision, which can be one whose deploy failed. A job on a
  different revision than the API is a job with different configuration than the API.
* **No `--network-configuration`.** The deployment is EC2 with `bridge` networking, so there is none
  to pass and ECS would reject one anyway.
* **Placement is the service's.** A service on a capacity provider reports no `launchType` and takes
  `--capacity-provider-strategy` instead; a service with `placementConstraints` needs them passed
  through, or the job lands on capacity the API is deliberately kept off. Both are on the
  `describe-services` output above — copy them across rather than restating them from memory.

Run one job at a time and in the order §4d states, and **not while the external chain is in flight**
(§2): the advisory lock keeps a collided job from double-writing, but it makes the second run a
no-op rather than a correct one.

**There is no public job endpoint and no shared job token.** A credential that can start a job has
to live somewhere, and "a token in repository secrets that the internet-facing API accepts forever"
is a worse somewhere than the deploy role that already exists.

If `describe-services` returns a `failures` array instead of a service, stop and read it before
retrying: an absent service and a cluster name pointing at the wrong cluster look identical from
outside and have completely different fixes.

### b. The image, or a checkout (an operator, by hand)

```sh
# inside the deployed image
node packages/api/dist/jobs.js staleness --json

# locally, against a database you own
DATABASE_URL=… pnpm --filter @the-rfp-hub/api jobs staleness
DATABASE_URL=… pnpm --filter @the-rfp-hub/api jobs embedding-backfill --limit 100 --passes 5
DATABASE_URL=… pnpm --filter @the-rfp-hub/api jobs notification-dispatch --limit 100 --passes 5
pnpm --filter @the-rfp-hub/api jobs --help
```

Exit codes: `0` ran or declined · `1` the job threw · `2` the invocation was wrong.

### c. `POST /v1/admin/jobs/{job}/run` (a reviewer, from the dashboard)

A **signed-in administrator session only** — an API key is refused with `403 session_required`,
because a global role never elevates an API key. It runs **exactly one pass**: a request that
looped a cursor job to exhaustion would hold a connection and a socket for as long as the backlog
took, and the thing allowed to take that long is the container task. It takes the same advisory
lock, so pressing it while the scheduled run is in flight answers `skipped: "locked"`.

### d. The external scheduler — the contract it depends on

The nightly chain is started by **an external scheduler such as a workflow orchestrator**, outside
this repository, as one-off container tasks on the deployed image (§2). Nothing about a job changes
when it is; what that caller depends on is stated here so it does not have to be inferred from the
runner, and so it does not quietly stop being true.

**The entry point is the image's, and the argv is the whole interface.**

```sh
node packages/api/dist/jobs.js <job> --json
```

`<job>` is one of the six names in §1 — the catalogue in
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
between *different* jobs — which never exclude each other. Two chains running in overlapping windows
therefore interleave, and the interleaving loses work while every single run reports success:

> Chain A is partway through `verification-backfill`. Chain B starts, finds that job locked,
> correctly reports `skipped: "locked"`, exits `0` — and moves on to `staleness`, which now runs
> **before** A's verification pass has finished. A successful check is a "still real" signal that
> **resets the staleness clock** (`verification.service.ts` writes `lastSeenAt` on a match), and
> staleness's inactivity test is `coalesce(last_seen_at, updated_at)`. So entries A was about to
> prove active are closed as long-inactive instead. A's verification finishes a minute later and
> does **not** reopen them — it never writes `status`, and staleness only ever closes rows that are
> still `open`. Both chains are green. The dataset is wrong.

**So the ordering is the caller's to hold, and the lock will not arbitrate it.** As deployed:

> **One scheduler runs the whole chain. `analytics-rollup`, `retention`, `embedding-backfill`,
> `verification-backfill` and `notification-dispatch` are INDEPENDENT — any order, or in parallel.
> `staleness` runs AFTER ALL FIVE HAVE EXITED. The chain must finish before 03:17 UTC, when the
> open-data export publishes, so the snapshot is a closed dataset rather than a half-maintained
> one.**

Each clause carries weight:

* **The five are independent.** They write nothing the others read, so nothing is bought by
  ordering them and a caller is free to run them concurrently. Serialising the whole chain is a
  valid way to satisfy the rule below, not the rule.
* **`staleness` after all five, by EXIT.** It reads what `verification-backfill` writes, and exit
  code — not elapsed time — is what says a job is done: a caller that starts `staleness` on a timer
  is racing the pass it depends on, and the race is silent (the walk-through above).
* **Finished before 03:17.** `nightly-export.yml` publishes on its own cron and waits for nothing
  (§2). A chain still running at 03:17 publishes a dataset maintained halfway.
* **One caller.** Starting a job by hand (§4a) while the external chain is in flight is the one
  overlap nothing prevents; the lock will merely make the collided jobs no-ops rather than correct
  runs.

**Nothing about the chain publishes the open-data dataset.** `.github/workflows/nightly-export.yml`
publishes on its **own cron**, `17 3 * * *` — nothing triggers it, from this repository or outside
it (§2). So a failed chain has no effect on whether the day's snapshot appears, only on what it
*says*, and a missed or failed external run is invisible to the export. **Monitor the external run
on its own** — nothing downstream will report its absence for you.

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
   `rfp-hub-<env>-service` exist and the environment's cluster variable is set. Both are
   prerequisites of the deploy workflow itself, so this is nearly always already true; a caller
   reads the service for its revision and its placement, and has nothing to read until then.
4. Grant the identity that starts tasks **`ecs:RunTask` on the task definition and `iam:PassRole`
   for the task's execution and task roles**. This is the one permission that may be missing:
   registering a task definition and updating a service — which the deploy workflow already does —
   does not imply the right to start a task from it. `ecs:DescribeServices` is already exercised by
   the deploy workflow with the same credential. Nothing else is needed; the maintenance chain uses
   the **runtime** credential inside the container, not a DDL one.
5. Set `<ENV>_APP_BASE_URL` to the canonical frontend origin, then deploy once so the API workflow
   writes it into the service task definition inherited by background tasks.
6. Prove the wiring by hand once per environment (§4a): start `notification-dispatch` as a one-off
   task and read its `--json` line out of the task's log. A wrong cluster or an undeployed service
   fails on the `describe-services` call, before anything is started.
7. Point the **external scheduler** at the same entry point, with the ordering §4d requires, and
   monitor it there: this repository schedules nothing and will not report its absence. Nothing
   here triggers the export either — it runs on its own cron (§2) — so confirm it separately, by
   waiting for its 03:17 run or by dispatching *Nightly open-data export* directly.

---

## 6. Configuration each job reads

| Job | Variables |
|---|---|
| `analytics-rollup` | none. It reads whatever `opportunity_events` holds, so `ANALYTICS_ENABLED=false` makes it a no-op by starvation rather than by a flag |
| `retention` | `ANALYTICS_RETENTION_DAYS` (default 180) |
| `embedding-backfill` | `EMBEDDING_PROVIDER`, `DEDUPE_SIMILARITY_THRESHOLD`, `DEDUPE_MAX_MATCHES` |
| `verification-backfill` | `VERIFICATION_ENABLED`, `VERIFY_TIMEOUT_MS`, `VERIFY_MAX_BYTES`, `VERIFIER_EGRESS_PROXY` |
| `staleness` | `STALENESS_INACTIVE_DAYS` (default 90) |
| `notification-dispatch` | `APP_BASE_URL`, `EMAIL_TRANSPORT`, provider-specific email settings, and `EMAIL_FROM`; the immediate API queue additionally reads `NOTIFICATION_QUEUE_MAX` (default 100 waiting ids) |

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

Every authority-bearing data mutation a maintenance job makes is an `audit_log` row with `actor_kind='job'`,
`actor_account_id = NULL` and `actor_api_key_id = NULL`, in the **same transaction** as the
mutation. The patch names the job and its reason:

```json
{ "job": "staleness", "reason": "past_due", "status": { "before": "open", "after": "closed" } }
```

`reason` is `past_due` or `inactive`, and it is the difference between "this programme's deadline
has passed" and "nobody has re-asserted this listing in ninety days" — which are different things to
tell a publisher. The public trail shows the changed field names and the actor `job`; the entry's
submitter, its publisher and T3+ see the full patch.

Notification delivery is operational telemetry, not an authority-bearing change, so it does not
append an audit action. The notification row itself carries `email_dispatched_at` or
`email_failed_at`; the payload's private `emailDelivery` member records a bounded attempt count and
safe failure code while a retry is pending, and is stripped from account-facing API responses.
