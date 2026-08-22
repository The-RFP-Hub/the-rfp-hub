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
    api,
  }) => {
    await page.goto(stack.urls.frontend);

    // `Log out` is the product's own signal that a session was restored — waiting for it is waiting
    // for the thing the criterion is about, rather than for a timeout to expire.
    await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();

    // THE NAVIGATION IS GROUPED NOW, and this list follows the grouping rather than the old flat
    // row. `Directory` and `How it works` are the public pair — present for a stranger too;
    // `Dashboard`, `Your listings`, `Account` and `API keys` are what THIS ACCOUNT owns, rendered
    // from what `GET /v1/me` answered, and every session may manage its own keys.
    //
    // `Listings` became `Your listings` in the regroup: the account group says whose things these
    // are. The criterion is unchanged — a capability-gated link that exists only once the API has
    // answered for this account — so the label is updated rather than the assertion weakened.
    const nav = page.getByRole("navigation", { name: "Sections" });
    for (const label of [
      "Directory",
      "How it works",
      "Dashboard",
      "Your listings",
      "Account",
      "API keys",
    ]) {
      // `exact` matters: the brand link's accessible name contains "Directory" as a substring, so a
      // loose match resolves to two elements and fails strict mode. The nav labels are exact
      // strings; pinning them is the tighter assertion anyway.
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    // AN ACCOUNT WITH MEMBERSHIPS GETS AN ORGANISATION ENTRY, beside its listings rather than behind
    // two clicks on the account page. Its SHAPE follows the account: one membership gets the
    // organisation's own name and its own address, because a landing page listing exactly one row is
    // a click that answers nothing; several get a chooser.
    //
    // WHICH CASE THIS RUN IS IN IS READ FROM THE API, NOT ASSUMED. Earlier files grant the publisher
    // memberships on further organisations while exercising claims, so the count here is a
    // consequence of what has run — and hard-coding either shape would make this test an assertion
    // about execution order.
    const me = await (await api("publisher")).get<{
      memberships: Array<{ slug: string; name: string }>;
    }>("/v1/me");
    expect(me.status).toBe(200);
    const memberships = me.body.memberships;
    expect(
      memberships.length,
      "this actor is a member of at least one organisation",
    ).toBeGreaterThan(0);
    const only = memberships.length === 1 ? memberships[0] : undefined;
    const organisation = nav.getByRole("link", {
      name: only ? only.name : "Organisations",
      exact: true,
    });
    await expect(
      organisation,
      "a member's organisation belongs beside their listings, not behind two clicks",
    ).toBeVisible();
    await expect(organisation).toHaveAttribute(
      "href",
      only ? `/organisations/${encodeURIComponent(only.slug)}` : "/organisations",
    );

    // DUPLICATES LEFT THE TOP LEVEL, and the demotion is the assertion rather than a side effect:
    // it is a view OF your listings, so it is reached from `/listings` and no longer competes with
    // them in the header.
    await expect(
      nav.getByRole("link", { name: "Duplicates", exact: true }),
      "Duplicates is not a top-level destination any more",
    ).toHaveCount(0);
    await page.goto(`${stack.urls.frontend}/listings`);
    await expect(
      page.getByRole("link", { name: /duplicate/i }).first(),
      "…and `/listings` owes it a permanent way in, whether or not anything is flagged",
    ).toBeVisible();

    // The STAFF group is capability-gated on the API's own answer, and this actor is a plain
    // publisher: hiding a link is presentation, but the link being absent is what `canReview` and
    // `canAdmin` came back false for.
    for (const label of ["Review queues", "Accounts & roles"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toHaveCount(0);
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

    // THE STANDARD IS TYPED NOW, NOT PASTED: `fundingDetails` used to be a JSON textarea and is a
    // set of sections keyed off the funding type. The two named after schema fields are asserted
    // because a publisher reading a conformance error about `fundingInfo` or `fundingDetails` has
    // to be able to find the part of the form that owns it.
    //
    // Matched loosely rather than exactly: the section NUMBER is a stylesheet counter on the
    // legend, and generated content counts towards an accessible name.
    await expect(page.getByRole("group", { name: /Funding information/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /Funding details — grant/ })).toBeVisible();

    // SUBMIT IS ALWAYS LIVE, and that is the criterion rather than a relaxation of it. A disabled
    // button that does not say why cannot be told apart from a broken page, so pressing it on an
    // empty document REVEALS the problems instead of sending — and the same press must not have
    // created anything.
    const submit = page.getByRole("button", { name: "Submit", exact: true });
    await expect(submit, "the button stays live so that pressing it can answer").toBeEnabled();
    await submit.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Not conformant yet." }),
      "pressing Submit on an empty form answers, in the page's own words",
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Submitted." }),
      "…and answering is not sending",
    ).toHaveCount(0);

    // A PROBLEM IS ALSO ADDRESSED TO ITS FIELD, not only listed in the summary. That is the whole
    // point of the per-field pass: `aria-invalid` is what a screen reader announces on the input
    // rather than as loose red text somewhere below.
    const title = page.getByLabel(/^Title/);
    await expect(title).toHaveAttribute("aria-invalid", "true");

    // …and then the form is actually FILLED AND SUBMITTED. Stopping at the refusal proves only that
    // the form validates: a broken submit handler, or a frontend pointed at the wrong API, passes
    // that unchanged. The assertion that matters is that a person typing into this form ends up
    // with a row the API will serve back.
    //
    // THE LABELS ARE MATCHED BY PREFIX because several carry a suffix the form adds — "— optional"
    // on anything the schema permits to be absent, "— permanent, cannot be changed later" on the
    // id. Anchoring at the start pins the field without pinning the annotation.
    const localId = `form-${Date.now()}`;
    const id = `${stack.namespaces.publisher}:${localId}`;
    await title.fill(`Dashboard form entry ${localId}`);
    await page
      .getByLabel(/^Description/)
      .fill(
        "An entry submitted through the publisher dashboard's own form by the end-to-end suite.",
      );
    // The primary operating organisation: its name, and the slug that IS the publishing namespace.
    await page.getByLabel(/^Name/).fill(stack.namespaces.publisher);
    await page.getByLabel(/^Slug/).fill(stack.namespaces.publisher);

    // THE APPLICATION LINK IS ADVISORY, NEVER BLOCKING — the schema makes it optional and the form
    // does not overrule the schema. It says the consequence instead, and says it before anything is
    // pressed, because advice that arrives after the fact cannot change the answer.
    //
    // It appears TWICE and both are intended: beside the field it is about, and in the advisory list
    // alongside the validator's own check-tier findings. The count is asserted rather than papered
    // over with `.first()`, because "one of them went missing" is a real regression.
    const applicationUrl = page.getByLabel(/^Application URL/);
    const advice = page.getByText(/no way to apply and source verification never runs/i);
    await expect(advice, "advice is shown next to its field AND in the advisory list").toHaveCount(
      2,
    );
    await expect(advice.first()).toBeVisible();
    await expect(
      applicationUrl,
      "an empty application link is advised against, not marked invalid",
    ).not.toHaveAttribute("aria-invalid", "true");
    await applicationUrl.fill(stack.urls.programme);

    // The id is filled LAST and on purpose: until it is touched it follows the title and the
    // primary slug, and typing into it is what stops the derivation.
    await page.getByLabel(/^Id\b/).fill(id);

    await submit.click();

    // THE RESULT REPLACES THE FORM. A live Submit button under an outcome panel is how the same
    // opportunity gets submitted twice, so the panel's presence and the form's absence are one
    // assertion about the same fix.
    await expect(page.getByRole("heading", { name: "Submitted." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open this listing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit another" })).toBeVisible();
    await expect(submit, "the form is gone, so it cannot be sent again").toHaveCount(0);

    // The frontend reports the outcome in its own words; the API is the authority on whether the
    // row exists, so both are checked and the API's answer is the one that decides.
    const publisher = await api("publisher");
    const stored = await publisher.get<{ id: string; title: string }>(
      `/v1/me/opportunities/${encodeURIComponent(id)}`,
    );
    expect(stored.status, "the entry the form created must exist at the API").toBe(200);
    expect(stored.body.title).toBe(`Dashboard form entry ${localId}`);

    // "Open this listing" goes to the row that was just created, which is the only thing that makes
    // the panel a way forward rather than a dead end.
    await page.getByRole("link", { name: "Open this listing" }).click();
    // Compared on the DECODED path: an id carries a colon, which is percent-encoded in the address
    // and would make a literal comparison a test of the encoder rather than of the destination.
    await expect(page).toHaveURL((url) => decodeURIComponent(url.pathname) === `/listings/${id}`);
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
