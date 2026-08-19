/**
 * M3-5 — the dashboard in a real browser, and the traffic counters that a real browser moves.
 *
 * These are the criteria that only a browser can establish. Everything else in the suite could in
 * principle be argued from HTTP; "a person can sign in, see the right navigation, submit an entry
 * and read its traffic" cannot.
 *
 * SELECTORS ARE ROLE- AND TEXT-BASED. `Chrome.tsx` carries no test ids, and adding them would mean
 * editing production markup for this suite's convenience — so the selectors are the same things a
 * screen reader uses. The one consequence to know: the navigation renders NOTHING until `/v1/me`
 * resolves, so every navigation assertion waits for a link rather than reading the DOM immediately.
 *
 * ONE ANALYTICS FACT SHAPES THIS FILE. `detailViews` is captured on the PUBLIC
 * `GET /v1/opportunities/:id` only. The dashboard's own detail page reads through the owner and
 * reviewer routes, which do not count — by design, so a publisher refreshing their own page cannot
 * inflate their numbers. The countable-view assertion therefore navigates a real browser to the
 * public API URL with an ordinary desktop user agent, which is what a visitor's browser does.
 */
import {
  expect,
  pollUntil,
  skipUnlessActor,
  skipUnlessBrowserSession,
  test,
} from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

test.describe("M3-5 the signed-in dashboard", () => {
  test.beforeEach(({ stack }) => {
    // The browser session must be the PUBLISHER's: these specs read entries that actor created.
    skipUnlessActor(stack, "publisher");
    skipUnlessBrowserSession(stack, "publisher");
  });

  test("a signed-in session shows the account and the navigation its capabilities allow", async ({
    page,
    stack,
  }) => {
    await page.goto(stack.urls.frontend);

    // `Log out` is the product's own signal that a session was restored — waiting for it is waiting
    // for the thing the criterion is about, rather than for a timeout to expire.
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

    // `Directory` is public and always present; `Dashboard` is where the signed-in overview moved
    // when `/` became the public directory. The rest is the capability-gated set — and every session
    // may manage its own keys, so `API keys` is there for a plain submitter too.
    for (const label of [
      "Directory",
      "Dashboard",
      "Listings",
      "Duplicates",
      "API keys",
      "Account",
    ]) {
      // `exact` matters: the brand link's accessible name ("RFP Hub — the directory and the…")
      // contains "Directory" as a substring, so a loose match resolves to two elements and fails
      // strict mode. The nav labels are exact strings; pinning them is the tighter assertion anyway.
      await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });

  test("a submitter is shown the API's own refusal on the privileged pages", async ({
    page,
    stack,
  }) => {
    test.skip(
      !stack.actors.submitter || stack.actors.submitter.shared === true,
      "BLOCKED: this needs a browser session on an UNPRIVILEGED account.",
    );

    for (const path of ["/review", "/admin"]) {
      await page.goto(`${stack.urls.frontend}${path}`);
      // Hiding a link is presentation; the page still renders, and what it renders is the API's
      // answer about this account — not a second, client-side authorization system.
      await expect(page.getByText(/does not have/i)).toBeVisible();
    }
  });

  test("an entry can be created through the form and reaches the API", async ({
    page,
    stack,
    api,
  }) => {
    await page.goto(`${stack.urls.frontend}/listings/new`);
    await expect(page.getByRole("heading", { name: "Submit an opportunity" })).toBeVisible();

    // An empty form cannot be submitted: the button stays disabled and the non-conformance is shown
    // by the client rather than being discovered by the server.
    await expect(page.getByRole("button", { name: "Submit" })).toBeDisabled();

    // …and then the form is actually FILLED AND SUBMITTED. Stopping at the disabled button proves
    // only that the form renders: a broken submit handler, or a frontend pointed at the wrong API,
    // passes that test unchanged. The assertion that matters is that a person typing into this form
    // ends up with a row the API will serve back.
    const localId = `form-${Date.now()}`;
    const id = `${stack.namespaces.publisher}:${localId}`;
    await page.getByLabel("Id", { exact: true }).fill(id);
    await page.getByLabel("Title", { exact: true }).fill(`Dashboard form entry ${localId}`);
    await page
      .getByLabel("Description", { exact: true })
      .fill(
        "An entry submitted through the publisher dashboard's own form by the end-to-end suite.",
      );
    await page
      .getByLabel("Operating organisation", { exact: true })
      .fill(stack.namespaces.publisher);
    await page
      .getByLabel("Operating organisation slug", { exact: true })
      .fill(stack.namespaces.publisher);
    await page.getByLabel("Application URL", { exact: true }).fill(stack.urls.programme);

    const submit = page.getByRole("button", { name: "Submit" });
    await expect(submit, "a conformant form enables its submit button").toBeEnabled();
    await submit.click();

    // The frontend reports the outcome in its own words; the API is the authority on whether the
    // row exists, so both are checked and the API's answer is the one that decides.
    await expect(page.getByText(/Submitted\./i)).toBeVisible();

    const publisher = await api("publisher");
    const stored = await publisher.get<{ id: string; title: string }>(
      `/v1/me/opportunities/${encodeURIComponent(id)}`,
    );
    expect(stored.status, "the entry the form created must exist at the API").toBe(200);
    expect(stored.body.title).toBe(`Dashboard form entry ${localId}`);
  });

  test("a key's secret is shown once and is gone after a reload", async ({ page, stack }) => {
    await page.goto(`${stack.urls.frontend}/keys`);
    await page.getByRole("button", { name: "Mint" }).click();

    const shown = page.getByRole("heading", { name: "Copy this now" });
    await expect(shown).toBeVisible();
    const secretBlock = page.locator("text=/rfph_[a-z0-9]{8}_/").first();
    await expect(secretBlock).toBeVisible();

    await page.reload();
    // The secret exists in exactly one place — the create response — and the page holding it is the
    // only chance to copy it. If a reload could show it again, it would be stored somewhere.
    await expect(page.getByRole("heading", { name: "Copy this now" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revoke" }).first()).toBeVisible();
  });

  test("publisher-supplied text is rendered, never executed", async ({
    page,
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const payload = '<script>window.__e2eXss = 1</script><img src=x onerror="window.__e2eXss = 1">';
    const document = opportunityFixture(stack.namespaces.publisher, `xss-${Date.now()}`, {
      title: `Untrusted ${payload}`,
      description: `Description ${payload}`,
    });
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    await page.goto(`${stack.urls.frontend}/listings/${encodeURIComponent(document.id as string)}`);
    // `.first()` because the title legitimately appears more than once on this page (the heading and
    // the traffic panel's label). The assertion is that the payload is rendered as TEXT — the node
    // holds the literal `<script>…` characters — not that it appears exactly once.
    const rendered = page.getByText("Untrusted", { exact: false }).first();
    await expect(rendered).toBeVisible();
    await expect(rendered).toContainText("<script>");

    // Every entry in this system is text somebody else wrote. If any of it can execute, the
    // dashboard hands every publisher a script-injection primitive against every reviewer.
    const executed = await page.evaluate(
      // `globalThis`, not `window`: this package's TypeScript configuration carries no DOM library
      // (it is a Node harness), and inside a page the two are the same object.
      () => (globalThis as { __e2eXss?: number }).__e2eXss,
    );
    expect(executed, "publisher content must never execute").toBeUndefined();
  });
});

test.describe("M3-5 analytics count what a visitor does", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  test("a real browser read of the public entry is counted, and a link-out is counted as a click", async ({
    page,
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `traffic-${Date.now()}`, {
      applicationUrl: stack.urls.programme,
    });
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const insights = async () => {
      const response = await publisher.get<{
        totals: { detailViews: number; listViews: number; applyClicks: number };
      }>(`/v1/insights/opportunities/${encodeURIComponent(id)}`);
      return response.body.totals;
    };
    const before = await insights();

    // The PUBLIC route, in a real browser, with an ordinary desktop user agent. The dashboard's own
    // detail page uses the owner route and deliberately does not count.
    await page.goto(`${stack.urls.api}/v1/opportunities/${encodeURIComponent(id)}`);
    // The list read is SEARCHED rather than taken from the default first page. A list view is
    // recorded per entry the page actually returns, and the default ordering is by next deadline —
    // so as soon as any fixture in the run carries a deadline (the staleness ones do), a plain
    // `GET /v1/opportunities` need not contain this entry at all, and the counter would never move
    // for a reason that has nothing to do with analytics.
    await page.goto(
      `${stack.urls.api}/v1/opportunities?q=${encodeURIComponent(document.title as string)}`,
    );

    // The event buffer flushes every two seconds, so the counter is polled rather than read once —
    // a single immediate read is a race this test would lose most of the time.
    const afterReads = await pollUntil(
      "a browser read is counted",
      insights,
      (totals) => totals.detailViews > before.detailViews && totals.listViews > before.listViews,
    );

    // Playwright follows redirects, so the 302 has to be captured as it goes past; asserting on the
    // final page would prove only that the fixture server answered.
    const redirect = page.waitForResponse(
      (response) => response.status() === 302 && /\/v1\/r\/.*\/apply/.test(response.url()),
    );
    await page.goto(`${stack.urls.api}/v1/r/${encodeURIComponent(id)}/apply`);
    await redirect;

    await pollUntil(
      "a link-out is counted as an apply click",
      insights,
      (totals) => totals.applyClicks > afterReads.applyClicks,
    );
  });

  test("today's traffic is visible before any rollup, and running the rollup does not double it", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `rollup-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const anon = publisher.as(undefined);
    for (let i = 0; i < 3; i++) await anon.get(`/v1/opportunities/${encodeURIComponent(id)}`);

    const read = async () => {
      const response = await publisher.get<{ totals: { detailViews: number } }>(
        `/v1/insights/opportunities/${encodeURIComponent(id)}`,
      );
      return response.body.totals.detailViews;
    };

    // Pre-rollup visibility is the point: a publisher looking at today's numbers should not have to
    // wait for a nightly job to see this morning's traffic.
    const live = await pollUntil(
      "today's reads are visible before any rollup",
      read,
      (views) => views >= 3,
    );

    expect(
      (await (await api("admin")).post("/v1/admin/jobs/analytics-rollup/run", {})).status,
    ).toBe(200);

    // The rollup ASSIGNS a day's total rather than adding to it, and `insights` unions today's raw
    // events with pre-today rollups — so running it must not change what is already displayed.
    expect(await read(), "the rollup must not double today's totals").toBe(live);
  });

  test("a 404 link-out moves no counter", async ({ stack, anonApi, api, opportunityFixture }) => {
    const publisher = await api("publisher");
    const clicks = async () => {
      const response = await publisher.get<{ totals: { applyClicks: number } }>(
        "/v1/insights/me/summary",
      );
      return response.body.totals.applyClicks;
    };
    const before = await clicks();

    const missing = await anonApi.get(
      `/v1/r/${encodeURIComponent(`${stack.namespaces.publisher}:nope`)}/apply`,
    );
    expect(missing.status).toBe(404);

    // A NEGATIVE about a BUFFERED counter cannot be read immediately.
    //
    // Events flush every two seconds, so a comparison made straight after the request is testing
    // whether the buffer had flushed yet — not whether an event was recorded. It would report "no
    // change" just as readily for a 404 that DID wrongly count. So a real click is issued after it
    // and waited for: once that one has landed, any event the 404 produced has certainly landed too,
    // and the counter can be compared against exactly the one increment that was legitimate.
    const real = opportunityFixture(stack.namespaces.publisher, `notfound-control-${Date.now()}`);
    const realId = real.id as string;
    expect((await publisher.post("/v1/opportunities", real)).status).toBe(201);

    const followed = await anonApi.get(`/v1/r/${encodeURIComponent(realId)}/apply`);
    expect(followed.status, "the control link-out is a real 302").toBe(302);

    const after = await pollUntil(
      "the control link-out is counted, which means the flush has happened",
      clicks,
      (value) => value > before,
    );
    expect(after - before, "only the real link-out may have counted").toBe(1);
  });

  test("another publisher cannot read someone else's traffic, and an anonymous reader cannot read any", async ({
    stack,
    api,
    anonApi,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `insights-acl-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const anonymous = await anonApi.get(`/v1/insights/opportunities/${encodeURIComponent(id)}`);
    expect(anonymous.status, "traffic is never public").toBe(401);

    if (!stack.actors.otherPublisher) {
      // CONDITIONAL, and recorded as such rather than quietly passing on the weaker pair above: the
      // full statement needs a SECOND VERIFIED PUBLISHER, and this run has none.
      test.skip(
        true,
        "BLOCKED: proving that another VERIFIED PUBLISHER is refused needs a second independent " +
          "publisher identity. The unauthenticated case above did run.",
      );
      return;
    }

    const other = await api("otherPublisher");
    const refused = await other.get<{ error: string }>(
      `/v1/insights/opportunities/${encodeURIComponent(id)}`,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_your_entry");
  });
});
