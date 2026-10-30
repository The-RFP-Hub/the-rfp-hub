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
    c.unmet(
      "publisher analytics",
      "the lifecycle criterion did not create a fixture to generate traffic for",
    );
    return c.finish();
  }
  if (!state.isPublic) {
    c.unmet(
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
  // `clicked` is the 302 alone, because that is what decides whether a click was counted below —
  // the API counts the leaving-page hop exactly like the direct one.
  const clicked = click.status === 302;
  const landing = linkOutLanding(click.location, {
    id,
    kind: "apply",
    destination: state.document?.applicationUrl,
  });
  c.expect(
    clicked && landing.ok,
    "the link-out redirects to the entry's own application channel, or to the hub's leaving page for it",
    `302 → ${click.location} (${landing.detail})`,
    clicked
      ? `302 → ${click.location ?? "(no Location)"}: ${landing.detail}`
      : `expected 302, got ${click.status ?? click.error}`,
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

/** The reasons the API's leaving page is sent with — its contract with the frontend. */
export const LEAVING_REASONS = ["closed", "unreviewed", "landing_changed"];

/**
 * Whether a link-out's `Location` is one of the TWO answers the API may give.
 *
 * The redirect goes straight to the entry's stored link only when a hub reviewer vouched for exactly
 * that link; otherwise it goes to the frontend's leaving page, `/leaving/{id}?link=…&reason=…`, which
 * shows the destination and the reason. This criterion's own fixture is a verified publisher's
 * auto-approved create — the textbook unvouched link — so on a deployment with the rule it SHOULD
 * get the leaving page, and a check that demanded the stored URL would fail a correct deployment.
 *
 * What is held fixed is that it is one of those two and nothing else: the leaving page must be for
 * THIS entry and THIS link, with a reason the frontend knows how to say. The origin is not checked
 * — it is the deployment's `APP_BASE_URL`, which this tool is not told — and neither is the stored
 * destination fetched; see `verifyRedirect` in checks/openapi.mjs for why a conformance run does not.
 */
export function linkOutLanding(location, { id, kind, destination }) {
  if (!location) return { ok: false, detail: "no Location header" };
  let target;
  try {
    target = new URL(location);
  } catch {
    return { ok: false, detail: `Location is not an absolute URL: ${JSON.stringify(location)}` };
  }
  if (destination) {
    let stored;
    try {
      stored = new URL(destination).href;
    } catch {
      stored = destination;
    }
    if (target.href === stored) return { ok: true, detail: "the entry's stored applicationUrl" };
  }
  const reason = target.searchParams.get("reason");
  if (
    target.pathname === `/leaving/${encodeURIComponent(id)}` &&
    target.searchParams.get("link") === kind &&
    LEAVING_REASONS.includes(reason)
  ) {
    return { ok: true, detail: `the hub's leaving page, reason ${reason}` };
  }
  return {
    ok: false,
    detail: `neither the stored link (${destination ?? "unknown"}) nor the leaving page /leaving/${encodeURIComponent(id)}?link=${kind}&reason=${LEAVING_REASONS.join("|")}`,
  };
}

async function totals(ctx, id) {
  const response = await callJson(ctx, `/v1/insights/opportunities/${encodeURIComponent(id)}`, {
    token: ctx.credential,
  });
  if (!response.ok || response.status !== 200 || !response.json?.totals) return null;
  return response.json.totals;
}

export const meta = {
  key: "analytics",
  requires: [{ key: "lifecycle", hard: true }],
  needs: ["api", "namespace", "credential"],
  writes: true,
  contract: { m3: "M3-6" },
};

export async function run(ctx) {
  await checkAnalytics(ctx.report, ctx, ctx.state);
}
