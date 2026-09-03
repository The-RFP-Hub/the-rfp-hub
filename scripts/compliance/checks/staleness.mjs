/**
 * Criterion 7 — **the staleness job closes entries whose deadline has passed**.
 *
 * It submits a fixture whose only fixed deadline is in the past, runs the job, and checks that the
 * entry is `closed` with a `close` row attributed to the JOB rather than to a person.
 *
 * THE SCHEDULE IS NOT WHAT THIS CHECKS. A compliance run cannot wait until 01:05 to find out
 * whether a cron fired. What it can establish is the half that matters and that a schedule cannot
 * fix if it is wrong: given the job runs, does it close the right entry, for the right reason,
 * leaving the right trail. That the job is SCHEDULED is a property of a scheduler outside this
 * repository, and the schedule, ordering and runbook are documented in
 * `packages/api/docs/jobs.md`.
 *
 * Running it on demand needs a T4 session (`--admin-token`). Without one this SKIPS, because a run
 * that could not start the job has established nothing about it.
 */
import { callJson } from "../client.mjs";
import { fixtureDocument, fixtureId } from "../fixtures.mjs";

export async function checkStaleness(report, ctx, state) {
  const c = report.criterion(
    "staleness",
    "Staleness job",
    "An open entry whose fixed deadline has passed is closed by the job, with the reason and the actor recorded.",
  );

  if (!state.writeToken) {
    c.skip("staleness closure", "the lifecycle criterion produced no write credential");
    return c.finish();
  }

  const id = fixtureId(ctx.namespace, state.run, "pastdue");
  const passed = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const created = await callJson(ctx, "/v1/opportunities", {
    method: "POST",
    token: state.writeToken,
    body: fixtureDocument({
      id,
      namespace: ctx.namespace,
      title: `M3 compliance past-due fixture ${state.run}`,
      // One FIXED deadline, in the past, and no rolling entry: exactly the condition `isPastDue`
      // names. A rolling entry here would (correctly) never close, and the fixture would prove
      // nothing.
      deadlines: [{ deadlineType: "fixed", date: passed, label: "application" }],
    }),
  });
  if (!created.ok || created.status !== 201) {
    c.fail(
      "a past-due fixture can be created",
      created.ok ? `HTTP ${created.status}: ${created.body?.slice(0, 300)}` : created.error,
    );
    return c.finish();
  }
  state.fixtureIds.push(id);
  c.pass("a past-due fixture can be created", `201, status ${created.json?.opportunity?.status}`);

  if (!ctx.adminToken) {
    c.skip(
      "the staleness job closes it",
      "no --admin-token: starting a job on demand is a signed-in administrator's capability, and the schedule that normally runs it cannot be waited for inside a compliance run. The fixture above is left in place and will be closed by the next scheduled run.",
    );
    return c.finish();
  }

  const run = await callJson(ctx, "/v1/admin/jobs/staleness/run", {
    method: "POST",
    token: ctx.adminToken,
    body: {},
  });
  if (!run.ok || run.status !== 200) {
    if (run.status === 403) {
      c.skip(
        "the staleness job closes it",
        "the supplied --admin-token is not an administrator session (403). Job runs are T4 and session-only: a global role never elevates an API key.",
      );
      return c.finish();
    }
    c.fail(
      "the staleness job can be started",
      run.ok ? `HTTP ${run.status}: ${run.body?.slice(0, 200)}` : run.error,
    );
    return c.finish();
  }
  if (run.json?.skipped === "locked") {
    c.skip(
      "the staleness job closes it",
      "another run of the job held the advisory lock, so this invocation correctly declined. That is the locking contract working; re-run in a moment to exercise the closure.",
    );
    return c.finish();
  }
  c.pass(
    "the staleness job can be started on demand",
    `shape ${run.json?.shape}, processed ${run.json?.processed}, passes ${run.json?.passes}`,
  );

  const detail = await callJson(ctx, `/v1/me/opportunities/${encodeURIComponent(id)}`, {
    token: ctx.credential,
  });
  c.expect(
    detail.json?.status === "closed",
    "the past-due entry is now closed",
    "status closed",
    `status ${JSON.stringify(detail.json?.status)} — a fixed deadline in the past with no rolling entry must close`,
  );

  const trail = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}/audit`, {
    token: ctx.credential,
  });
  const closure = (trail.json?.entries ?? []).find((entry) => entry.action === "close");
  if (!closure) {
    c.fail(
      "the closure is attributed to the job",
      `no \`close\` row in the trail; actions: ${(trail.json?.entries ?? []).map((e) => e.action).join(", ") || "(none)"}`,
    );
  } else {
    c.expect(
      closure.actorKind === "job",
      "the closure is attributed to the job, not to a person",
      `actorKind ${closure.actorKind}, actor ${closure.actor}`,
      `actorKind ${closure.actorKind} — an automatic closure must not look like an editorial decision somebody made`,
    );
    c.expect(
      closure.patch?.reason === "past_due",
      "the closure names why",
      "reason past_due",
      `reason ${JSON.stringify(closure.patch?.reason)} — "the deadline passed" and "nobody has touched this for ninety days" are different things to tell a publisher`,
    );
  }

  // A second run must change nothing. An idempotent job is what makes it safe to retry at all.
  const again = await callJson(ctx, "/v1/admin/jobs/staleness/run", {
    method: "POST",
    token: ctx.adminToken,
    body: {},
  });
  if (again.ok && again.status === 200 && again.json?.skipped === undefined) {
    const trailAgain = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}/audit`, {
      token: ctx.credential,
    });
    const closures = (trailAgain.json?.entries ?? []).filter((entry) => entry.action === "close");
    c.expect(
      closures.length === 1,
      "a second run writes no second closure",
      "exactly one `close` row",
      `${closures.length} \`close\` rows — the job is not idempotent against this entry`,
    );
  } else {
    c.skip("a second run writes no second closure", `the repeat run answered ${again.status}`);
  }

  return c.finish();
}
