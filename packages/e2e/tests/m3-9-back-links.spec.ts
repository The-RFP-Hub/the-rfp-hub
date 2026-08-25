/**
 * M3-9 — the labelled way back, and the state it has to preserve.
 *
 * THE PROBLEM THIS EXISTS FOR IS A ROUND TRIP, WHICH IS WHY IT IS AN END-TO-END TEST. A component
 * test can prove `parseReturnLink` rejects `//evil.example`, and the frontend suite does. What it
 * cannot do is establish that the origin ACTUALLY WROTE the parameter, that the destination read
 * it, and that following it lands on the screen the reader left — three components, a router and
 * two real navigations. The bug this replaced lived exactly in the seams: `/review?tab=claims` →
 * open a listing → back → `/review`, showing Submissions, which is a different screen.
 *
 * TWO ORIGINS, because they exercise different halves of the module. `/review` carries state in its
 * QUERY (which tab), and its label is derived from that query. `/organisations/<slug>` carries state
 * in its PATH, and its label is publisher-supplied text that travels as a second parameter — the one
 * case `returnLabel` consents to read from the URL rather than deriving.
 *
 * The allowlist itself is asserted in the frontend unit suite, where every rejected shape can be
 * enumerated cheaply. What is here is the part that needs the whole application running.
 */
import { expect, skipUnlessActor, skipUnlessBrowserSession, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

test.describe("M3-9 opening a listing from a queue, and getting back to it", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "otherPublisher", "reviewer");
  });

  test("from the review queue's claims tab, and back to the claims tab", async ({
    stack,
    api,
    contextAs,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const outsider = await api("otherPublisher");
    const stamp = Date.now();

    // A claim has to exist for the tab to have a row to open, and it has to be QUEUED rather than
    // granted: a claim for an organisation that is verified but is NOT among the entry's operating
    // organisations is 202, which is precisely a claim awaiting a reviewer.
    const document = opportunityFixture(stack.namespaces.publisher, `backlink-claim-${stamp}`, {
      title: `Back-link claim fixture ${stamp}`,
    });
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const filed = await outsider.post<{ status: string }>(
      `/v1/opportunities/${encodeURIComponent(id)}/claim`,
      {
        organizationSlug: stack.namespaces.other,
        note: `Back-link fixture ${stamp}`,
      },
    );
    expect(
      filed.status,
      "a claim on an organisation that does not operate the entry is queued",
    ).toBe(202);

    // The review surface needs the reviewer capability, and the browser session this project
    // supplies belongs to the publisher — so this drives a context signed in as the reviewer.
    const context = await contextAs("reviewer");
    const page = await context.newPage();

    await page.goto(`${stack.urls.frontend}/review?tab=claims`);
    await expect(page.getByRole("tab", { name: /^Claims/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const row = page.locator("tr").filter({ hasText: id });
    await expect(row, "the queued claim is on the claims tab").toHaveCount(1);
    await row.getByRole("link", { name: `Back-link claim fixture ${stamp}` }).click();

    // The listing carries where it came from — INCLUDING the tab, which is the state a plain
    // `/review` would have thrown away.
    await expect(page).toHaveURL((url) => url.searchParams.get("back") === "/review?tab=claims");

    // …and the way back NAMES the place, rather than being an arrow that could mean anything. The
    // label is derived from the origin's own query: `tab=claims` is "the claims queue".
    const back = page.getByRole("link", { name: "← Back to the claims queue" });
    await expect(back, "the way back says where it goes before it is clicked").toBeVisible();
    await back.click();

    // THE ROUND TRIP CLOSES ON THE SAME SCREEN. Landing on `/review` with Submissions selected is
    // the bug; the tab has to come back too.
    await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "claims");
    await expect(page.getByRole("tab", { name: /^Claims/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("tr").filter({ hasText: id })).toHaveCount(1);
  });

  test("from an organisation's own page, and back to it by name", async ({
    page,
    stack,
    api,
    opportunityFixture,
  }) => {
    skipUnlessBrowserSession(stack, "publisher");
    const slug = stack.namespaces.publisher;
    const outsider = await api("otherPublisher");
    const stamp = Date.now();

    // Filed by somebody outside the organisation, so it is waiting — the rows on an organisation's
    // page that link out are the pending ones.
    const document = opportunityFixture(slug, `backlink-org-${stamp}`, {
      title: `Back-link organisation fixture ${stamp}`,
    });
    const id = document.id as string;
    expect((await outsider.post("/v1/opportunities", document)).status).toBe(201);

    const origin = `/organisations/${encodeURIComponent(slug)}`;
    await page.goto(`${stack.urls.frontend}${origin}`);

    const row = page.locator("tr").filter({ hasText: id });
    await expect(row).toHaveCount(1);
    await row.getByRole("link", { name: `Back-link organisation fixture ${stamp}` }).click();

    // THE ORGANISATION'S NAME TRAVELS WITH THE LINK, and it is the one case that needs to: a slug
    // is not what anybody calls the place, and the destination has no way to look the name up.
    await expect(page).toHaveURL((url) => url.searchParams.get("back") === origin);
    await expect(page).toHaveURL((url) => url.searchParams.get("backLabel") === slug);

    const back = page.getByRole("link", { name: `← Back to ${slug}` });
    await expect(
      back,
      "the way back is labelled with the organisation, not with a slugified path",
    ).toBeVisible();
    await back.click();

    await expect(page).toHaveURL(
      (url) => decodeURIComponent(url.pathname) === `/organisations/${slug}`,
    );
    await expect(
      page.getByRole("heading", { name: /Awaiting review for this organisation/ }),
    ).toBeVisible();
    await expect(page.locator("tr").filter({ hasText: id })).toHaveCount(1);
  });

  /**
   * A listing reached WITHOUT an origin offers no way back, and that is the correct behaviour
   * rather than a missing feature.
   *
   * The alternative — inventing "← Back to your listings" for somebody who arrived from a pasted
   * link — sends a reader somewhere they have never been and calls it going back.
   */
  test("a listing opened from a bare link offers no way back at all", async ({
    page,
    stack,
    api,
    opportunityFixture,
  }) => {
    skipUnlessBrowserSession(stack, "publisher");
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `backlink-bare-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    await page.goto(`${stack.urls.frontend}/listings/${encodeURIComponent(id)}`);
    await expect(page.getByText(id, { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^← Back to/ })).toHaveCount(0);

    // An off-allowlist origin is dropped SILENTLY, not shown as an error: a malformed `back` is not
    // something the reader did or can fix, and rendering it would be an open redirect wearing this
    // application's chrome. `//evil.example` is the shape that defeats a naive `startsWith("/")`.
    await page.goto(
      `${stack.urls.frontend}/listings/${encodeURIComponent(id)}?back=${encodeURIComponent("//evil.example/phish")}`,
    );
    await expect(page.getByText(id, { exact: false }).first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^← Back to/ }),
      "an attacker-supplied destination is never offered as a way back",
    ).toHaveCount(0);
  });
});
