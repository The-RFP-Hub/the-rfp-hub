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

## 1. The catalog

The five jobs, **in the order `registry.ts` lists them, which is the order the chain runs them**:

| Job | Shape | What it does |
|---|---|---|
| **`all`** | chain | Runs the five below, in this order, in one process. **This is what a scheduler should call** — §4d. |
| `analytics-rollup` | sweep | Recomputes the **two days before today** in `opportunity_stats_daily` from the raw events, then **prunes** raw events older than `ANALYTICS_RETENTION_DAYS`. |
| `embedding-backfill` | cursor | Embeds entries with no *current* vector for the configured provider — missing, from another model or provider, stale against the entry's text, or lacking the overlap scalars — records the pairs that come out, then re-judges suspected pairs the current rule did not write. It is a repair pass, not the primary detector: a normal write runs the same detection, over the same candidates, before it answers. |
| `verification-backfill` | cursor | Fetches the `applicationUrl` of entries never checked, edited since their last check, or **not checked for `VERIFY_RECHECK_DAYS`** — never-checked first, at most `VERIFY_NIGHTLY_LIMIT` per invocation, paced `VERIFY_HOST_MIN_GAP_MS` apart per host — then prunes their run log to the newest `VERIFICATION_RUNS_KEEP`. A pass triggered over HTTP takes a smaller default slice (§4c). |
| `notification-dispatch` | cursor | Joins pending notification accounts to `auth_user`, composes duplicate-domain copy, and sends it through the central email service. |
| `staleness` | cursor | Closes past-due and long-inactive entries, and recomputes `next_deadline_at`. **Last, always** — §4d. |

The list lives in exactly one place — `src/modules/services/jobs/registry.ts` — which the runner,
the admin route and this table all read. A name that is not in it is refused by both callers rather
than starting a container task that quietly does nothing. `CHAIN`, exported from the same file, is
that list minus the deprecated aliases, and is what `all` runs; `test/unit/jobs.test.ts` pins the
sequence literally, so a new job joins the night deliberately rather than by being declared.

`all` is not itself a job: it takes no lock of its own, appears in no catalog, and is refused by
`POST /v1/admin/jobs/{job}/run`. It is the entry point running the catalog in order.

### `retention` is a deprecated alias, for one release

| Job | Shape | What it does |
|---|---|---|
| `retention` | sweep | **Deprecated.** Runs the retention prune alone. Exits `0`, with a notice on stderr. |

**The prune now runs inside `analytics-rollup`, in the same invocation.** They were never
independent: both sweep `opportunity_events` over a window keyed on `occurred_at`, and the prune is
only correct once the rollup has absorbed the days it is about to delete. As two scheduled tasks
that dependency was the *scheduler's* to remember and nothing's to enforce — a prune that ran on a
night the rollup failed would delete raw events whose totals were never recorded. In one invocation
the order cannot be got wrong, and a rollup that throws never reaches the delete. The count comes
back as `details.pruned` on the rollup's result.

The `retention` NAME is kept because the nightly chain is scheduled **outside this repository**
(§2): a caller still passing it would otherwise exit `2` — a maintenance run failing loudly, at
night, for a reason nobody at the console can act on. It does the prune alone, so the old six-name
chain and the new five-name one have the same outcome, and a caller that runs **both** simply
prunes twice, which deletes nothing the first pass left. `jobs.js all` never runs it, so it is not
double-work for anyone who has moved. **Drop it from your scheduler**; it will be removed.

These names, and the exit codes and `--json` shape that go with them, are what a caller outside this
repository depends on; §4d states that contract in one place.

### Cursor vs sweep, and why the distinction is load-bearing

Every job returns the same `{processed, remaining, skipped?}`. What differs is what `remaining`
means, and getting it wrong is the difference between a job that finishes and one that does not.

* A **cursor** job selects rows by a predicate **the run itself retires**. An embedded entry stops
  matching "has no embedding"; a closed entry stops matching "is open". `remaining` falls, so the
  runner may go round again.
* A **sweep** job deliberately **reprocesses a fixed window every time**. `analytics-rollup`
  re-selects the two days before today precisely so that an event written after its own day rolled
  over — a buffer flushing on a timer, a deployment restarting mid-flush — is never permanently
  missing. Its selection never empties, so it reports **`remaining: 0` always**, and that is what
  stops the runner looping it. The rule is structural, not a list of exceptions in the runner: a job
  that reports nothing remaining is not asked again.

  **Today is deliberately outside the window.** `GET /v1/insights/…` takes days strictly *before*
  today from `opportunity_stats_daily` and live-aggregates today's raw events instead, so that a
  publisher who posts in the morning sees real numbers rather than zeros. A rollup row for today is
  therefore a row nothing reads — a grouped scan of the busiest, still-growing day of the table
  whose result the next night's sweep overwrites before anyone could. The two settled days that
  remain are the late-arrival margin, and they are the whole reason the window is not one day.

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
the five jobs at **01:05 UTC**. They carry **one ordering rule** between them: the four below are
independent and may run in any order or in parallel; `staleness` runs **after all of them**.

```
UTC
01:05  external scheduler ──┬─ analytics-rollup ──────┐  (rolls up, then prunes)
                            ├─ embedding-backfill ────┤  independent of each other:
                            ├─ verification-backfill ─┤  any order, or in parallel
                            └─ notification-dispatch ─┘
                                       │
                                       └──> staleness   ← after ALL four, always

03:17  nightly-export.yml     publishes the dataset — its OWN cron, not chained (see below)
```

Running the five one at a time satisfies that rule; so does running the four together and
`staleness` when the last of them exits. The rule is the contract (§4d); serializing is one way to
meet it.

**A scheduler should not have to satisfy that rule by hand.** `node packages/api/dist/jobs.js all`
runs the whole chain in one task, in `CHAIN` order, so the ordering is enforced in-process instead
of by a caller in another repository remembering prose. That is the recommended invocation (§4d);
the per-name advisory lock is unchanged and still applies per job.

**This repository schedules nothing, and does not dispatch anything either.** There is no
maintenance workflow here: the external scheduler is the only caller that runs nightly, and the
manual path is an operator starting the same one-off task by hand (§4a) — a recovery after a failed
external run, or a check that the wiring works.

**Why `staleness` is last, and why one caller.** The advisory lock each job takes excludes a job
from **itself**, never one job from another (§3). So two callers whose windows overlap do not
double-write — but they do interleave, and `staleness` running while `verification-backfill` is
still going closes entries that a successful check was about to keep open, with **both runs
reporting success** (§4d has the walk-through). Putting `staleness` after everything, under a single
caller, is what prevents that: a successful check writes `lastSeenAt`, and staleness reads that
state after it has settled instead of underneath it. The other four write nothing each other reads,
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
publishes on time regardless; the dataset then advertises programs the API would have closed. The
snapshot reflects the staleness pass from earlier the same night, so an entry that falls past-due
after that pass is published as open and corrected the following night. The export is idempotent and
`workflow_dispatch` on it republishes immediately once the cause is fixed. **Monitor the external
run on its own** — nothing downstream will report its absence for you.

> **Not enforced.** Nothing makes the export wait for the chain to finish. An actual "after" would
> mean the external scheduler starting `nightly-export.yml` as its last step and that cron coming
> off. It is **not wired**. Deciding it is an owner's call, not this document's — until then the
> two-hour margin is the whole of the guarantee.

### What actually runs today

**As stated by the operator** — these facts are not corroborable from this checkout, so they are
attributed rather than asserted as fact this repository can verify: the external scheduler above is
an Airflow DAG, owned by the operator's data-warehouse project. It is not a workflow in this
repository, and there is no longer a dispatch path here to compare it against — it starts the same
one-off ECS tasks §4a describes: `run-task` overrides against the deployed image, on the API
service's own task definition, the revision the service is actually running. It runs at **01:05
UTC** daily, `staleness` after everything else, exactly the ordering this section states. Its
**first production run was 2026-08-26**, against release `prod-1.3.0`.

**That attestation is about a release older than this branch, and it describes six tasks.**
`prod-1.3.0` shipped the six-name catalog, so the DAG names `analytics-rollup`, `retention`,
`embedding-backfill`, `verification-backfill`, `notification-dispatch` and then `staleness`, one
task each. Nothing has to change for it to keep working: the prune now rides inside
`analytics-rollup` and `retention` survives as a deprecated alias that prunes alone (§1), so a
caller still naming six prunes twice, which deletes nothing the first pass left. What **should**
change is the shape — **one maintenance task, `node packages/api/dist/jobs.js all --json`** (§4d,
§5.7) — which holds the ordering in the process that knows what it is for instead of in a
dependency graph in another repository. Until that move happens, what the footprints below record
is six tasks that satisfied the rule, not one task that enforced it.

That run's logs live in the Airflow deployment itself and are **not reachable from this
repository** — there is no link to add here, and none this document can keep current if there were.
What an auditor without Airflow access can read instead is the same database the run wrote to, for
the run's calendar day. **None of what follows is job history — no row here names which caller ran
a job, or that one ran at all — it is the ordinary data the jobs write, read for the window a run
would have touched:**

* **`audit_log`** — every entry `staleness` closed that night, `actor_kind='job'` naming the job in
  the patch (§7):

  ```sql
  select id, subject_id, patch, created_at
  from audit_log
  where actor_kind = 'job'
    and action = 'close'
    and patch->>'job' = 'staleness'
    and created_at >= timestamptz '2026-08-26T00:00:00Z'
    and created_at <  timestamptz '2026-08-27T00:00:00Z'
  order by created_at;
  ```

* **`verification_runs`** — the checks in the window that **survived the retention bound**, from
  **any origin**. Two things keep this from being a count of what the backfill did.

  The table has no job/origin column: `VerificationService.verify()` writes the same row shape for a
  nightly `verification-backfill` pass, a submit-time check and a reviewer's manual re-check from
  the dashboard, so a row's mere existence proves a check happened, not that the job ran it. The
  signal worth reading for is a **burst around 01:05 UTC**, not the rows' presence — and that burst
  now has a ceiling, `VERIFY_NIGHTLY_LIMIT` (500 per invocation, §1), because the re-check TTL
  keeps the selection permanently refilled rather than draining it.

  And the log is **bounded, not a history**: every insert prunes its entry to the newest
  `VERIFICATION_RUNS_KEEP` runs (5 by default) and the backfill prunes its whole selection again
  afterwards. An often-checked entry therefore loses its older rows *inside* the window, so what
  this query returns is a floor on the checks that happened, never the number. What is never pruned
  is the `verify_source` row every check also appends to `audit_log` (§7) — `actor_kind = 'job'`
  for the backfill and the submit-time queue alike, which separates a reviewer's check from an
  unattended one and still does not say which unattended caller ran it.

  ```sql
  select id, opportunity_id, run_at, http_status, matched, error
  from verification_runs
  where run_at >= timestamptz '2026-08-26T00:00:00Z'
    and run_at <  timestamptz '2026-08-27T00:00:00Z'
  order by run_at;
  ```

* **`opportunity_stats_daily`** — the prior day's rollup, rewritten (not incremented) by
  `analytics-rollup`:

  ```sql
  select opportunity_id, day, list_views, detail_views, source_clicks, apply_clicks, updated_at
  from opportunity_stats_daily
  where day = '2026-08-25'
    and updated_at >= timestamptz '2026-08-26T00:00:00Z'
    and updated_at <  timestamptz '2026-08-27T00:00:00Z'
  order by updated_at desc;
  ```

  All three columns above are `timestamptz`; an unzoned literal is interpreted in the reading
  session's `TimeZone` setting, not UTC, and silently shifts the window. The explicit `timestamptz
  '…Z'` casts are what keep the bounds meant here regardless of that setting.

**There is no admin endpoint or CLI for any of the three, and the read-only routes that touch these
tables are not job history either.** `POST /v1/admin/jobs/{job}/run` (§4c) starts a job; it does not
report a history of past runs, and nothing under `/v1/admin/jobs` reads one back. `GET
/v1/opportunities/:id/audit` (§7) is the public per-entry trail — one entry at a time, and it
presupposes the id. `GET /v1/opportunities/:id/verification` returns only the **latest**
`verification_runs` row for an entry, with the same any-origin caveat as above. The `/v1/insights/*`
routes read `opportunity_stats_daily` for a publisher's own numbers. None of the four tells an
auditor whether a scheduled run happened, only what the data currently says. Direct SQL against the
three tables above, run by someone with database access, is the only path that does not require
reaching into Airflow.

**These are the only in-database footprints, and reading them proves less than it looks like.** The
prune inside `analytics-rollup`, `embedding-backfill` and `notification-dispatch` leave no
comparable trace here: a healthy prune may have nothing past the retention window to delete, a
healthy `embedding-backfill` may have no backlog, a healthy `notification-dispatch` may have no
pending notification. Presence in the three tables above is **consistent with** a run having
happened; **absence proves nothing** — not that a job failed, and not that it didn't run — because
every one of these jobs is also reachable by hand, as a one-off task (§4a) or inside the image
(§4b), and from the dashboard one pass at a time (§4c). None of it says anything about **ordering**
either: the *Not enforced* note above stands regardless of what these queries return, and once the
chain moves to `all`, the ordering is a property of the process that ran, which no row here records.

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
  the result looking wrong. Its retention prune deletes by age, so a second run finds nothing left
  to delete and reports `details.pruned: 0`.
* `staleness` closes only entries that are still `open`, re-checking under a row lock inside the
  transaction, so a publisher's edit racing the walk wins. A second run finds nothing to close and
  writes no second audit row. A row that *throws* — a deadlock victim, a lock timeout — is logged,
  counted in `details.failed` and skipped, exactly as both backfills already do: the walk is ordered
  by id, so letting one row out would abandon every candidate after it, and the same ones every
  night. A skipped row stays in the predicate for the next run.

  **But a pass in which EVERY WRITE IT ATTEMPTED failed throws, and the run exits 1.** Per-row
  isolation is right for a poison row and wrong for a broken deployment — a check constraint added
  to `audit_log`, a revoked grant, a full disk — and one row at a time the two look identical. Over
  a whole pass they do not: `failed > 0 && failed === attemptedWrites` means nothing this run tried
  to write was accepted, so there is no evidence writing works at all. Reporting that as a counter
  and exiting 0 is a green nightly run in which the staleness pass has silently stopped happening,
  while the export keeps publishing programs that are over.

  The denominator is **attempted writes**, not rows settled, and that is deliberate. Most candidates
  on a given night need no change and open no transaction at all; and a transaction can open, take
  its row lock, find that a publisher already resolved the entry, and commit having changed nothing
  — a successful write attempt that moves no counter. Judging by "did anything settle" would call
  such a pass systemic the moment one unrelated row went bad. Judging by "did every attempt fail"
  asks the question the counters can answer. One bad row among writes that succeeded stays a
  counter, which is what catching per row is for.
* `embedding-backfill` selects on the absence of the thing it produces, and it has **two arms**,
  both of which retire what they select. The first is the embedding cursor: an entry with no row, a
  row from another model or provider, a row whose `content_hash` no longer matches its text, **or a
  row missing `norm` / `token_count`** — the fourth predicate arm, which the overlap detection arm
  decides on and which is gated on the provider declaring it can supply them
  (`EmbeddingProvider.suppliesNorm`), so a provider that cannot never selects rows it could never
  fix. The second arm runs only once the first has drained: suspected pairs whose `rules_key`
  differs from the current rule's are re-judged against both stored vectors and either deleted or
  rewritten with the new similarity, signal and key together. That is what makes
  `DEDUPE_OVERLAP_ENABLED=false` a real rollback — and it fixes the same latent bug for
  `DEDUPE_SIMILARITY_THRESHOLD`, where a threshold change used to strand every pair the old value
  wrote, because pruning only runs for entries the backfill selects
  and a drained backfill selects nothing.

  Neither arm records anything a write would not. Detection has ONE candidate set — the caller's
  scope trims only what a response is told about, never what is searched or written — so this job
  finds a write's pairs already there and refreshes them rather than writing second copies of them.

  **`rules_key` is DERIVED, not a version somebody bumps.** It is a digest of the predicate's shape
  and the effective configuration — both thresholds, the token floor, the cosine floor, the switch,
  and the provider/model identity. So changing any of those four `DEDUPE_OVERLAP_*` variables, or
  `DEDUPE_SIMILARITY_THRESHOLD`, is by itself enough to make the affected rows stale and get them
  retired on the next nightly run. There is no constant to remember and no release to cut.

  **After deploying the overlap arm**, the first run selects the whole table on the norm predicate.
  It does **not** re-embed in the model sense — the vectors, the `content_hash`es and the model
  string are unchanged — it recomputes two scalars the featurizer was already producing and writes
  them. Run it to `remaining: 0` in the same maintenance step as the deploy; until it drains, the
  overlap arm simply does not fire for the rows it has not reached, which is degraded detection and
  never wrong detection.
* `verification-backfill` selects on the absence of a check **or on a check having expired**, so
  its selection refills on a rolling schedule rather than draining to nothing — see "The re-check
  TTL" below. Its prune step is idempotent too: it keeps the newest `VERIFICATION_RUNS_KEEP` runs of
  the entries the pass touched, so a second run deletes nothing — as is the prune every run
  insertion does for its own entry.
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

### The re-check TTL, and why a failed fetch is not a check

`verification-backfill` used to select `application_url IS NOT NULL AND merged_into_id IS NULL AND
(verified_at IS NULL OR verified_at < updated_at)`, and that predicate **retires an entry
permanently**. Applying a verdict deliberately does not bump `updated_at` (the section below says
why), so the moment `verified_at` is stamped, `verified_at < updated_at` is false and stays false.
A seeded entry nobody ever edits was checked once, in the week it was imported, and never again.

That is not merely a stale flag. `staleness` closes an entry with no future fixed deadline once
`coalesce(last_seen_at, updated_at)` is `STALENESS_INACTIVE_DAYS` old, and the only thing that
refreshes `last_seen_at` is a **matched** check. One check, then silence, then the whole rolling and
no-deadline half of the corpus auto-closing ninety days after it was seeded.

So the predicate gains a third clause — `verified_at < now() - VERIFY_RECHECK_DAYS` — and with it
three consequences worth stating:

* **The selection no longer drains, so the cap bounds the INVOCATION rather than the pass.** It
  refills on a rolling schedule, so `remaining` is not "work still owed tonight" — and `remaining`
  is what the runner loops on (`processed > 0 && remaining > 0`, up to `--passes`, **20 by
  default**). So `verification-backfill` **always reports `remaining: 0`** and puts what its
  predicate still matches in `details.deferred`. Two mechanisms hold the budget, because neither
  covers the other's case:

  * the service keeps a **fetch budget** — set from the first batch's effective limit, decremented
    per fetch *attempt* — so several batches on one instance share one budget;
  * the unconditional `remaining: 0`, because `registry.ts` builds a **new service for every pass**,
    which would reset that counter. What stops the loop in a deployment is the report.

  The rule is unconditional rather than "zero once the cap bit" because a pass coming in *under*
  the limit leaked just as surely: 499 selected against a 500 limit, some settled and some left owed
  by a transient failure, is `processed > 0` and `remaining > 0` — and the next pass gets a fresh
  full budget, so a 500 cap bought 997 fetches without ever appearing to bite.

  `VERIFY_NIGHTLY_LIMIT` (500) is the budget. **To drain a backlog, raise `--limit`, not
  `--passes`** — the first is the budget and the second can no longer multiply it.
* **Never-checked entries come first.** The order is `verified_at ASC NULLS FIRST, id`, so when the
  cap bites it drops a month-old re-check rather than an entry nobody has ever fetched.
* **A failed fetch is not a check.** A run that never reached the source — `timeout`,
  `dns_failure`, `transport_failure` — is still recorded, but it leaves `verified_at` and
  `verified_against_source` exactly as they were, and `processed` does not count it. Stamping on a
  timeout would suppress the entry for a further `VERIFY_RECHECK_DAYS`, and three suppressed months
  are precisely the ninety days after which `staleness` closes it: a resolver hiccup would close
  live listings. Everything else **is** a verdict and does stamp — any HTTP response at all
  (a 404 is an answer, not an outage), and the refusals `scheme_not_allowed`, `address_refused:*`,
  `content_type_not_allowed`, `too_many_redirects`, `redirect_without_location` and
  `redirect_malformed`, which are facts about the URL a submitter supplied or about a server that
  will still be answering the same way tomorrow, and would learn nothing from being re-fetched
  nightly. `redirect_malformed` — a `Location` that is not a URL — exists as its own category for
  exactly that reason: as an unclassified `TypeError` it surfaced as `transport_failure`, landed in
  the transient bucket, and had the entry re-fetched every night forever.

The cost of that last rule, stated plainly: a domain that has genuinely stopped resolving stays in
the selection, at the head of it, indefinitely. The nightly cap bounds what that costs, and
`staleness` closes such an entry at ninety days on its own, since nothing is refreshing its
`last_seen_at`. Retrying a dead host is the price of not retiring a live one during an outage.

**The pass is paced per host, and per HOP.** A corpus clusters by publisher, so a serial walk over
500 entries is fifty requests to one foundation's domain in the two seconds that domain takes to
answer them — indistinguishable from a scraper, and a block reads back here as "every entry from
this publisher stopped matching". The backfill therefore holds at least **one second between
fetches to the same host**, in process, for the duration of one pass, and reports what that cost as
`details.pacedMs`.

The pacer is handed to the fetcher as its `onHop` hook rather than applied to the entry's own URL,
because **a redirect is a request to a different server**. A corpus is full of vanity domains that
all redirect to one grants platform; spacing only the requested host would space thirty vanity
hosts perfectly and land thirty requests on the platform behind them in the same second — the exact
burst this exists to prevent, aimed at the one host that actually serves the pages.

**The wait happens inside the transport, after the address is resolved, classified and pinned, and
immediately before the socket.** Everything upstream of that can refuse the request outright — a
scheme that is not `http(s)`, a name that does not resolve, an address that is loopback, link-local
or otherwise private — and none of those open a socket, so none of them owe anyone a pause. Pacing
earlier made a batch of ten refused entries sleep nine seconds between refusals, spending the run's
time on the entries that cannot succeed. Nothing with an empty host is paced either: `file:`,
`mailto:` and `data:` all parse to one. The pin is unaffected by the wait — the address is fixed for
that connection, so nothing re-resolves while the pacer holds.

A reviewer's own `POST .../verify` is **not** paced: one request is not a crawl, and making it queue
behind a batch would charge politeness to the wrong person.

The gap is `VERIFY_HOST_MIN_GAP_MS`, a **setting rather than a constant**, for two reasons. It is
the one number that decides how long a pass takes, so an operator watching a nightly run stretch
needs to be able to move it without a deploy of new code. And `0` is a legitimate value for a stack
whose only source host is its own: the e2e runner points every fixture at a server it started in its
own process tree and kills in its `finally`, and paying it a real second per entry buys nothing and
costs the suite more wall clock than the rest of the run. **No deployment sets it to `0`** — the
pacer's own behavior is covered by `test/unit/host-pacer.test.ts`, which is where spacing belongs.

**A re-check that finds the page unmoved says so.** The stored digest is over the raw bytes, so an
equal digest is proof nothing changed since the last check — which is what a monthly re-check finds
almost every time. **Unless either fetch stopped at `VERIFY_MAX_BYTES`**: the digest then covers
only the retained prefix, so two genuinely different versions of a long page that share their first
2 MiB hash identically, and "unchanged" would be a claim about a prefix dressed as a claim about the
page. Both sides have to be complete for equal digests to mean equal pages; when either is not, the
run takes the ordinary path and stores the fresh extraction. The run is still written and the assessment still recomputed (the *record* may
have moved even though the page did not), but it is flagged `extracted.snapshotUnchanged` and
carries the previous run's snapshot text forward rather than a second extraction of identical bytes.
It still refreshes `verified_at` and `last_seen_at` on a match: "unmoved and still matching" is a
stronger still-real signal than a page that changed, not a weaker one.

Conditional requests — `If-None-Match` / `If-Modified-Since`, which would save the transfer as well
as the storage — are **not** sent. Neither the fetcher's result nor `verification_runs` keeps a
response's `ETag` or `Last-Modified`, so there is nothing to send them from without a migration.

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
along with the chain's schedule: the external scheduler runs the five nightly, and an operator who
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
# inside the deployed image — the whole chain, or one job
node packages/api/dist/jobs.js all --json
node packages/api/dist/jobs.js staleness --json

# locally, against a database you own
DATABASE_URL=… pnpm --filter @the-rfp-hub/api jobs all
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

**One pass is not by itself a wall-clock bound**, and for one job it is nowhere near one.
`verification-backfill` spaces its fetches at `VERIFY_HOST_MIN_GAP_MS` (default one second) per
host, and a corpus clusters hard by publisher — so its scheduled selection of `VERIFY_NIGHTLY_LIMIT`
(500) is **eight minutes of one pass** in the case the pacer exists for. No reviewer's browser and
no proxy in front of the API will wait for that; the request is aborted, the job keeps running to
completion behind it, and the retry that follows meets its own advisory lock.

So a job whose per-row cost is a round trip to somebody else's server declares an **interactive
limit** — `interactiveLimit` in `src/modules/services/jobs/registry.ts`, `10` for
`verification-backfill` — and this route uses it **when the caller names no `limit`**. It is a
default, not a ceiling: a `limit` in the body is honored exactly as given, because this route is
also how a staging operator asks for a bigger slice, and answering with ten while reporting success
would be a quieter failure than a slow response. **Draining a real backlog is still (a) or (b)**,
which have no socket to lose.

Every other job's pass is bounded by its own query rather than by politeness, declares no
interactive limit, and is unchanged by this.

### d. The external scheduler — the contract it depends on

The nightly chain is started by **an external scheduler such as a workflow orchestrator**, outside
this repository, as one-off container tasks on the deployed image (§2). Nothing about a job changes
when it is; what that caller depends on is stated here so it does not have to be inferred from the
runner, and so it does not quietly stop being true.

**The entry point is the image's, and the argv is the whole interface.**

```sh
node packages/api/dist/jobs.js all --json     # RECOMMENDED: the whole chain, ordered in-process
node packages/api/dist/jobs.js <job> --json   # one job, if you have a reason to
```

**Call `all`.** It runs `CHAIN` — `analytics-rollup`, `embedding-backfill`, `verification-backfill`,
`notification-dispatch`, `staleness` — sequentially, in this process, so the ordering rule below is
**enforced by the code that knows what it is for** rather than by a scheduler holding a rule written
in prose in a repository it does not read. A caller that names the five tasks itself is still
correct if it sequences them correctly; `all` is correct without having to.

Two things `all` does NOT change. The **advisory lock is still per job**, taken by each job in turn
under its own name (§3) — `all` takes no lock of its own, so two overlapping `all` runs still
interleave exactly as two overlapping hand-rolled chains would. And **a job that throws does not
stop the chain**: `staleness` has to run after the others have *exited*, which is not the same as
after they have *succeeded*, and skipping the pass the 03:17 export reads because an unrelated
backfill could not reach its provider would publish a dataset advertising programs that are over.
The failure is carried in the result and in the exit code instead.

`<job>` is one of the names in §1 — the catalog in `src/modules/services/jobs/registry.ts` is the
one place a name is spelled, and a name that is not in it exits `2` rather than doing nothing.
`retention` is a deprecated alias kept for one release (§1); drop it from your scheduler. `--limit`
and `--passes` are available and job-specific; neither is required, and both apply to every job in
an `all` run.

**It runs on the API service's own task definition**, as a container command override and nothing
else. The image, the runtime `DATABASE_URL`, every key of the `secrets:` array, the execution and
task roles are already assembled there and the deploy workflows keep them current — so an external
caller supplies **no additional environment**, and must not, because a second copy of that list is a
copy that goes stale in exactly the way that matters.

**Exit codes are the contract**, and they are the same for every caller:

| Code | Means |
|---|---|
| `0` | The job ran, **or declined** — another run held the lock, or its feature is not configured |
| `1` | The job threw. For `all`: **any** job in the chain threw; the rest still ran |
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

**`all --json` writes exactly one ARRAY**, on one line, holding those same objects in the order they
ran — so a parser written against a single job reads an element of it unchanged:

```json
[{"job":"analytics-rollup","shape":"sweep","processed":42,"remaining":0,"details":{"pruned":8140},"passes":1,"elapsedMs":950}, …]
```

A job that **threw** is in the array too, with `processed`, `remaining` and `passes` at `0` and one
extra key, `error`, carrying its message. `error` is the only thing that distinguishes it, and it is
absent everywhere else — a caller can treat the array as "every job, one entry each" and check the
exit code, or read `error` per job to see which one went. Without `--json`, each job's human line is
written as it finishes rather than at the end, so a task log shows where the chain has got to.

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

**So the ordering is the caller's to hold, and the lock will not arbitrate it — which is why `all`
now holds it for you.** As deployed:

> **One scheduler runs `jobs.js all`, once. `analytics-rollup`, `embedding-backfill`,
> `verification-backfill` and `notification-dispatch` are INDEPENDENT — any order, or in parallel.
> `staleness` runs AFTER ALL FOUR HAVE EXITED. The chain must finish before 03:17 UTC, when the
> open-data export publishes, so the snapshot is a closed dataset rather than a half-maintained
> one.**

Each clause carries weight:

* **The four are independent**, in the sense that matters: none of them needs another to have run
  for its own result to be right, so a caller running them itself is free to run them in any order
  or concurrently. `all` runs them one at a time anyway — they share one database and one
  container's CPU, the chain has over two hours of margin, and it does not need the minutes.

  One soft preference rides along with that order, and it is latency rather than correctness:
  `embedding-backfill` runs with the immediate-email accelerator switched off (a job container
  tears its pool down as soon as the job resolves, which would strand a fire-and-forget send), so
  the notifications it inserts wait for the dispatcher. `CHAIN` puts `notification-dispatch` after
  it, which gets them out the SAME night. Reverse them and nothing breaks: the rows are durable and
  the next sweep takes them.
* **`staleness` after all four, by EXIT.** It reads what `verification-backfill` writes, and exit
  code — not elapsed time — is what says a job is done: a caller that starts `staleness` on a timer
  is racing the pass it depends on, and the race is silent (the walk-through above). Inside `all`
  this is a `for` loop over `CHAIN` and cannot be got wrong.
* **Finished before 03:17.** `nightly-export.yml` publishes on its own cron and waits for nothing
  (§2). A chain still running at 03:17 publishes a dataset maintained halfway. The one job whose
  selection no longer drains is `verification-backfill`, and what keeps it inside that window is
  `VERIFY_NIGHTLY_LIMIT`: the cap, not the predicate, is what bounds its runtime, so raising it
  (or passing a larger `--limit`) is a decision about how long the chain may take. **The cap bounds
  the whole invocation, not one pass** — the job always reports `remaining: 0` precisely so
  `--passes 20` cannot multiply it — so the ceiling on a night's outbound fetches is
  `VERIFY_NIGHTLY_LIMIT`, whatever `--passes` says, and `details.deferred` is where the work left
  for tomorrow is counted.
* **One caller.** Starting a job by hand (§4a) while the external chain is in flight is the one
  overlap nothing prevents; the lock will merely make the collided jobs no-ops rather than correct
  runs. Moving to `all` shrinks this to a single task an operator can see is running, but does not
  remove it.

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
   task and read its `--json` line out of the task's log, then `all` for the full chain, `staleness`
   included. A wrong cluster or an undeployed service fails on the `describe-services` call, before
   anything is started.
7. Point the **external scheduler** at `node packages/api/dist/jobs.js all --json` — one task,
   with the ordering §4d requires already held in-process — and monitor it there: this repository
   schedules nothing and will not report its absence. A scheduler still naming the five jobs
   individually keeps working; one still naming `retention` should drop it (§1). Nothing
   here triggers the export either — it runs on its own cron (§2) — so confirm it separately, by
   waiting for its 03:17 run or by dispatching *Nightly open-data export* directly.

---

## 6. Configuration each job reads

| Job | Variables |
|---|---|
| `analytics-rollup` | `ANALYTICS_RETENTION_DAYS` (default 180), for the prune it ends with. The rollup half reads whatever `opportunity_events` holds, so `ANALYTICS_ENABLED=false` makes it a no-op by starvation rather than by a flag |
| `retention` *(deprecated)* | `ANALYTICS_RETENTION_DAYS` — the same prune, alone |
| `embedding-backfill` | `EMBEDDING_PROVIDER`, `DEDUPE_SIMILARITY_THRESHOLD`, `DEDUPE_MAX_MATCHES`, `DEDUPE_OVERLAP_ENABLED`, `DEDUPE_OVERLAP_THRESHOLD`, `DEDUPE_OVERLAP_MIN_TOKENS`, `DEDUPE_OVERLAP_MIN_SIMILARITY` |
| `verification-backfill` | `VERIFICATION_ENABLED`, `VERIFY_TIMEOUT_MS`, `VERIFY_MAX_BYTES`, `VERIFIER_EGRESS_PROXY`, `VERIFY_RECHECK_DAYS` (default 30), `VERIFY_NIGHTLY_LIMIT` (default 500), `VERIFY_HOST_MIN_GAP_MS` (default 1000), `VERIFICATION_RUNS_KEEP` (default 5) |
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

`reason` is `past_due` or `inactive`, and it is the difference between "this program's deadline
has passed" and "nobody has re-asserted this listing in ninety days" — which are different things to
tell a publisher. The public trail shows the changed field names and the actor `job`; the entry's
submitter, its publisher and T3+ see the full patch.

Notification delivery is operational telemetry, not an authority-bearing change, so it does not
append an audit action. The notification row itself carries `email_dispatched_at` or
`email_failed_at`; the payload's private `emailDelivery` member records a bounded attempt count and
safe failure code while a retry is pending, and is stripped from account-facing API responses.
