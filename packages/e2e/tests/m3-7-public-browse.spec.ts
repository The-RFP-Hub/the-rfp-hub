/**
 * The anonymous visitor: the directory, an entry, and the two counters a real reader moves.
 *
 * WHY THIS IS ITS OWN FILE RATHER THAN PART OF `m3-5`. That file is about the SIGNED-IN dashboard,
 * and every test in it is gated on a browser session belonging to the publisher
 * (`skipUnlessBrowserSession`). These criteria are the opposite claim — that none of this needs an
 * account — so folding them in would have put them behind a guard that contradicts what they assert,
 * and they would have silently stopped running at exactly the ladder levels where a session is
 * unavailable. One area per file is the convention here; the public surface is a new area.
 *
 * EVERY CASE RUNS IN A CONTEXT BUILT FRESH, WITH NO `storageState`. The project supplies a signed-in
 * one (see `playwright.config.ts`), which would make "an anonymous visitor can read this" untestable
 * — the page would render for a publisher and prove nothing about a stranger. The contexts below are
 * created per test and closed in a `finally`.
 *
 * The user agent is stated explicitly for the same reason it is elsewhere: `analytics-hash.ts`
 * excludes bot agents, so a countable read has to come from an ordinary desktop agent. This file
 * carries no `@bot-ua` tag and therefore runs only in the real-agent project.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { DESKTOP_UA, expect, pollUntil, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

/** A context with no stored session, and the desktop agent the analytics hasher counts. */
async function anonymous(
  browser: import("@playwright/test").Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ userAgent: DESKTOP_UA, storageState: undefined });
  return { context, page: await context.newPage() };
}

test.describe("M3-7 the public directory", () => {
  test.beforeEach(({ stack }) => {
    // Only a publisher is needed: the pending entry below is made by writing OUTSIDE the publisher's
    // own namespace, which lands `pending` (M3-2 asserts that rule directly). Requiring a separate
    // submitter would block this whole area at identity counts where it is perfectly testable.
    skipUnlessActor(stack, "publisher");
  });

  test("lists a published entry, hides a pending one, and narrows on a filter", async ({
    browser,
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const stamp = Date.now();
    // A token that appears in the title and nowhere else in the corpus, so the search below narrows
    // to exactly one row deterministically rather than "probably".
    const token = `dirprobe${stamp}`;

    const listed = opportunityFixture(stack.namespaces.publisher, `public-listed-${stamp}`, {
      title: `Public directory probe ${token}`,
    });
    expect((await publisher.post("/v1/opportunities", listed)).status).toBe(201);

    // Same publisher, someone else's namespace — accepted, but not published.
    const pending = opportunityFixture(stack.namespaces.other, `public-pending-${stamp}`, {
      title: `Public directory pending ${token}`,
    });
    const pendingResponse = await publisher.post<{ reviewStatus: string }>(
      "/v1/opportunities",
      pending,
    );
    expect(pendingResponse.status).toBe(201);
    expect(pendingResponse.body.reviewStatus, "the fixture must actually be pending").toBe(
      "pending",
    );

    const { context, page } = await anonymous(browser);
    try {
      await page.goto(stack.urls.dashboard);
      await expect(page.getByRole("heading", { name: "Funding opportunities" })).toBeVisible();

      // The filter is a parameter the endpoint declares — the list route validates its querystring
      // with `additionalProperties: false`, so an invented one would be a 400 rather than a control
      // that quietly does nothing.
      await page.getByLabel("Search", { exact: true }).fill(token);
      await page.getByRole("button", { name: "Search" }).click();

      const publishedLink = page.getByRole("link", { name: new RegExp(`probe ${token}`) });
      await expect(publishedLink, "a published entry is readable without an account").toBeVisible();

      // The decisive half: the pending entry matches the same search and must still not appear.
      // `GET /v1/opportunities` serves approved-and-listed rows only, whoever asks.
      await expect(
        page.getByRole("link", { name: new RegExp(`pending ${token}`) }),
        "a pending entry is never in the public directory",
      ).toHaveCount(0);

      // …and the filter genuinely narrowed rather than the page happening to be short.
      const searchHit = await page.getByRole("link", { name: new RegExp(token) }).count();
      expect(searchHit, "the search returns the one matching entry").toBe(1);
    } finally {
      await context.close();
    }
  });
});

test.describe("M3-7 the public entry page", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  test("renders the entry as text, never executing it, and shows a redacted history", async ({
    browser,
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const stamp = Date.now();
    const payload =
      '<script>window.__e2ePublicXss = 1</script><img src=x onerror="window.__e2ePublicXss = 1">';
    const originalTitle = `Public original ${stamp} ${payload}`;

    const document = opportunityFixture(stack.namespaces.publisher, `public-detail-${stamp}`, {
      title: originalTitle,
      description: `Public description ${stamp} ${payload}`,
    });
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    // A replace, so the history has an `update` row with a changed field — and so the OLD title
    // becomes a value that the public trail must not disclose.
    const replacedTitle = `Public replaced ${stamp}`;
    expect(
      (
        await publisher.put(`/v1/opportunities/${encodeURIComponent(id)}`, {
          ...document,
          title: replacedTitle,
        })
      ).status,
    ).toBe(200);

    const { context, page } = await anonymous(browser);
    try {
      await page.goto(`${stack.urls.dashboard}/opportunities/${encodeURIComponent(id)}`);

      await expect(page.getByRole("heading", { name: new RegExp(replacedTitle) })).toBeVisible();
      // The id and the description reach the page as text.
      await expect(page.getByText(id, { exact: false }).first()).toBeVisible();
      await expect(page.getByText(`Public description ${stamp}`, { exact: false })).toBeVisible();

      // Every entry here is text somebody else wrote, and this page is served to strangers. If any
      // of it can execute, a publisher has a script-injection primitive against every visitor.
      const executed = await page.evaluate(
        () => (globalThis as { __e2ePublicXss?: number }).__e2ePublicXss,
      );
      expect(executed, "publisher content must never execute on the public page").toBeUndefined();

      // ── the redacted history ─────────────────────────────────────────────────────────────────
      // It lives in a collapsed `<details>`, so it is opened first: its contents are in the DOM but
      // not visible, and asserting on a hidden element would prove the markup exists rather than
      // that a reader can see it.
      const history = page.locator("details", { has: page.getByText("Change history") });
      await history.getByText("Change history").click();

      await expect(history.getByRole("cell", { name: "update", exact: true })).toBeVisible();
      await expect(history.getByRole("cell", { name: "create", exact: true })).toBeVisible();
      // A time for each, and the changed FIELD NAME.
      await expect(history.getByText("title", { exact: false }).first()).toBeVisible();

      // The redaction itself: an anonymous reader gets the field names and never the values, so the
      // superseded title — a value — must appear nowhere in the trail.
      await expect(
        history.getByText(`Public original ${stamp}`, { exact: false }),
        "the public history discloses field names, never values",
      ).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("M3-7 what an anonymous visitor's traffic counts", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  test("a stranger's read counts as a detail view, and following the apply link counts as a click", async ({
    browser,
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(
      stack.namespaces.publisher,
      `public-traffic-${Date.now()}`,
      {
        applicationUrl: stack.urls.programme,
      },
    );
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const totals = async () => {
      const response = await publisher.get<{
        totals: { detailViews: number; applyClicks: number };
      }>(`/v1/insights/opportunities/${encodeURIComponent(id)}`);
      return response.body.totals;
    };
    const before = await totals();

    const { context, page } = await anonymous(browser);
    try {
      // Every response in this context, collected BEFORE the click. The apply control opens a new
      // tab (`target="_blank"`), so the redirect happens on a popup rather than on this page —
      // `page.waitForResponse` would never see it. A context-level listener sees both.
      const responses: Array<{ status: number; url: string }> = [];
      context.on("response", (response) => {
        responses.push({ status: response.status(), url: response.url() });
      });

      // The public detail page performs the read the API counts: `GET /v1/opportunities/:id`. The
      // publisher's own dashboard pages deliberately do NOT count, which is why this has to be the
      // public page in a real browser.
      await page.goto(`${stack.urls.dashboard}/opportunities/${encodeURIComponent(id)}`);
      await expect(page.getByRole("link", { name: "Open the application page" })).toBeVisible();

      const afterRead = await pollUntil(
        "an anonymous read of the public page is counted as a detail view",
        totals,
        (value) => value.detailViews > before.detailViews,
      );

      const popup = page.waitForEvent("popup").catch(() => undefined);
      await page.getByRole("link", { name: "Open the application page" }).click();
      const opened = await popup;

      // A 302, not a 200 at the destination: the redirect is what the API records, and a client that
      // silently followed it would prove only that the fixture server answered.
      await pollUntil(
        "the apply link goes through the API's redirect",
        async () => responses,
        (seen) =>
          seen.some(
            (response) =>
              response.status === 302 &&
              /\/v1\/r\/.*\/apply/.test(decodeURIComponent(response.url)),
          ),
      );

      await pollUntil(
        "and the redirect is counted as an apply click",
        totals,
        (value) => value.applyClicks > afterRead.applyClicks,
      );

      await opened?.close().catch(() => undefined);
    } finally {
      await context.close();
    }
  });
});
