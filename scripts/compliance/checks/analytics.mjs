/**
 * Criterion 6 — **a publisher's analytics load, for an entry with real traffic**.
 *
 * WHAT THIS CRITERION CAN AND CANNOT ESTABLISH, stated up front because the completion criterion is
 * worded about a dashboard: this tool proves that **the API records real reads and serves the
 * numbers back to the entry's publisher, today, before any rollup has run**. It does not open a
 * browser. That the dashboard RENDERS those numbers is established by the dashboard's own render
 * test and by the manual acceptance checklist with its screenshot; this criterion is the half that
 * can be checked mechanically against a live deployment, and the report says so rather than
 * implying more.
 *
 * THE TWO USER-AGENTS ARE THE WHOLE TRICK. The API excludes its own automation from capture by
 * name, and `rfphub-m3-compliance` is on that list — so this checker's ordinary requests are
 * uncountable by design, and could never demonstrate counting. The traffic below is therefore
 * generated under a plain agent, and then read back under the compliance agent, so measuring does
 * not change the measurement.
 */
import { TRAFFIC_AGENT, call, callJson, mapLimit } from "../client.mjs";

const SETTLE_ATTEMPTS = 8;
const SETTLE_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkAnalytics(report, ctx, state) {
  const c = report.criterion(
    "analytics",
    "Publisher analytics",
    "Real reads and link-outs are counted and served back to the entry's publisher on the same day, before any rollup.",
  );

  const id = state.publishedId;
  if (!id) {
    c.skip(
      "publisher analytics",
      "the lifecycle criterion did not create a fixture to generate traffic for",
    );
    return c.finish();
  }
  if (!state.isPublic) {
    c.skip(
      "publisher analytics",
      "the fixture landed pending, so it has no public detail route to read and no link-out to click. Run with a credential for a verified member of --namespace.",
    );
    return c.finish();
  }

  const path = `/v1/opportunities/${encodeURIComponent(id)}`;
  const before = await totals(ctx, id);
  if (before === null) {
    c.fail(
      "GET /v1/insights/opportunities/{id} serves the publisher's numbers",
      "no readable baseline",
    );
    return c.finish();
  }

  // ── generate traffic ─────────────────────────────────────────────────────────
  const views = Math.max(1, ctx.views);
  const reads = await mapLimit(Array.from({ length: views }), ctx.concurrency, () =>
    call(ctx, path, { agent: TRAFFIC_AGENT }),
  );
  const served = reads.filter((r) => r.ok && r.status === 200).length;
  c.expect(
    served === views,
    `${views} detail reads are served`,
    `${served}/${views} answered 200`,
    `${served}/${views} answered 200 — the traffic this criterion measures was not all delivered`,
  );

  const click = await call(ctx, `/v1/r/${encodeURIComponent(id)}/apply`, { agent: TRAFFIC_AGENT });
  const clicked = click.status === 302;
  c.expect(
    clicked,
    "the link-out redirects to the entry's own application channel",
    `302 → ${click.location}`,
    `expected 302, got ${click.status ?? click.error}`,
  );

  // The buffer flushes on a timer, so the numbers arrive shortly after the reads do. That is what
  // "best-effort" means in practice, and polling for it is honest about the mechanism.
  let after = before;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    await sleep(SETTLE_INTERVAL_MS);
    const current = await totals(ctx, id);
    if (current === null) break;
    after = current;
    if (current.detailViews - before.detailViews >= views) break;
  }

  const gained = after.detailViews - before.detailViews;
  c.expect(
    gained >= views,
    "the reads are counted and visible the same day, before any rollup",
    `detailViews +${gained} (from ${before.detailViews} to ${after.detailViews})`,
    `detailViews +${gained} after ${views} reads. Capture is buffered in memory and flushed on a timer, so a small shortfall is the documented best-effort behaviour rather than a contract violation — but a zero means capture is off (ANALYTICS_ENABLED) or this agent was excluded.`,
  );
  if (clicked) {
    c.expect(
      after.applyClicks > before.applyClicks,
      "the link-out click is counted",
      `applyClicks +${after.applyClicks - before.applyClicks}`,
      "the redirect was served but no click was recorded",
    );
  }

  // The publisher's own overview, which is what the dashboard's landing screen reads.
  const summary = await callJson(ctx, "/v1/insights/me/summary", { token: ctx.credential });
  c.expect(
    summary.ok && summary.status === 200 && Array.isArray(summary.json?.opportunities),
    "GET /v1/insights/me/summary serves the publisher's overview",
    `${summary.json?.opportunities?.length ?? 0} entries with traffic in the window`,
    summary.ok ? `HTTP ${summary.status}` : summary.error,
  );

  // …and it is not public. A publisher's numbers are theirs.
  const anonymous = await callJson(ctx, `/v1/insights/opportunities/${encodeURIComponent(id)}`);
  c.expect(
    anonymous.status === 401 || anonymous.status === 403,
    "another reader cannot see this publisher's numbers",
    `unauthenticated read → ${anonymous.status}`,
    `unauthenticated read → ${anonymous.status ?? anonymous.error}; insights must not be public`,
  );

  c.info(
    "scope of this criterion",
    "this establishes that the API counts real traffic and serves it to the publisher. That the DASHBOARD renders it is covered by the dashboard's render test and the manual acceptance checklist, not by this tool.",
  );

  return c.finish();
}

async function totals(ctx, id) {
  const response = await callJson(ctx, `/v1/insights/opportunities/${encodeURIComponent(id)}`, {
    token: ctx.credential,
  });
  if (!response.ok || response.status !== 200 || !response.json?.totals) return null;
  return response.json.totals;
}
