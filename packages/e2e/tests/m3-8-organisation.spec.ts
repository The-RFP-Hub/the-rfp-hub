/**
 * M3-8 — an organisation deciding about its own namespace.
 *
 * WHAT IS NEW HERE, AND WHY IT IS NOT `/review`. A Hub reviewer decides about anybody. A VERIFIED
 * MEMBER decides about entries filed under their own organisation's slug, and the API scopes them
 * differently on purpose: an entry published under some other namespace answers **404** rather than
 * 403, so nothing on this surface can be used to find out what is queued elsewhere. That difference
 * is invisible from a component test — it is a property of the route, the row and the membership
 * together — which is why it is asserted here over real HTTP.
 *
 * THE CONFLICT OF INTEREST IS THE WHOLE DESIGN. Anybody may file a listing ABOUT an organisation,
 * so an organisation refusing one in its own name is exactly the decision that has to answer for
 * itself. The API enforces the counterweight — a written reason is required, and the decision is
 * attributed to the deciding member BY HANDLE rather than coarsened to "reviewer" — and this file
 * pins both halves: the UI refusing to send an empty reason, and the audit row naming the person.
 *
 * WHO PLAYS WHOM. The organisation's member is the `publisher` actor, because the browser session
 * belongs to it (see `skipUnlessBrowserSession`). The OUTSIDER who files into that namespace is
 * `otherPublisher`: it is a genuinely different account, and — being verified in its own
 * namespace — it is exempt from the pending cap, so seeding two submissions here cannot be
 * confused with the cap criterion that `m3-1` owns.
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import {
  DESKTOP_UA,
  expect,
  freshIdentity,
  skipUnlessActor,
  skipUnlessBrowserSession,
  test,
} from "../src/fixtures.js";
import { ApiClient } from "../src/http.js";

test.describe.configure({ mode: "serial" });

/** A context with no stored session: what a stranger reading the public directory actually has. */
async function anonymous(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ userAgent: DESKTOP_UA, storageState: undefined });
  return { context, page: await context.newPage() };
}

/**
 * The account's public handle, set if it has none.
 *
 * ATTRIBUTION IS THE POINT OF THIS FILE, and an account with no handle is attributed as
 * "community" — which is honest but says nothing about who decided. So the handle is established
 * through the product's own route (`PATCH /v1/me`, session only) rather than assumed, and the
 * assertions below quote what the API answered rather than what this function asked for.
 */
async function ensureHandle(client: ApiClient, wanted: string): Promise<string> {
  const me = await client.get<{ handle: string | null }>("/v1/me");
  if (me.body.handle) return me.body.handle;
  const updated = await client.patch<{ handle: string | null }>("/v1/me", { handle: wanted });
  expect(updated.status, `PATCH /v1/me → ${updated.text.slice(0, 200)}`).toBe(200);
  expect(updated.body.handle, "a handle the account set must come back").toBe(wanted);
  return wanted;
}

test.describe("M3-8 the organisation's own page", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "otherPublisher");
    skipUnlessBrowserSession(stack, "publisher");
  });

  test("a member approves a submission filed in the organisation's name, and it publishes", async ({
    page,
    browser,
    stack,
    api,
    opportunityFixture,
  }) => {
    const slug = stack.namespaces.publisher;
    const outsider = await api("otherPublisher");
    const stamp = Date.now();
    const token = `orgapprove${stamp}`;

    // FILED BY SOMEBODY ELSE, INTO THIS ORGANISATION'S NAMESPACE. `otherPublisher` publishes in its
    // own namespace and has no membership here, so this lands pending — which is the state the
    // whole page is about.
    const document = opportunityFixture(slug, `org-approve-${stamp}`, {
      title: `Filed by an outsider ${token}`,
    });
    const id = document.id as string;
    const filed = await outsider.post<{ reviewStatus: string }>("/v1/opportunities", document);
    expect(filed.status).toBe(201);
    expect(filed.body.reviewStatus, "an outsider's write into this namespace waits").toBe(
      "pending",
    );

    await page.goto(`${stack.urls.frontend}/organisations/${encodeURIComponent(slug)}`);

    // ANY membership is enough to SEE this page; verification is what adds the decision controls.
    // This actor has both, and the page says which of the two it is being shown.
    await expect(page.getByRole("heading", { name: slug, exact: true }).first()).toBeVisible();
    await expect(page.getByText("You publish directly.")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Awaiting review in this namespace/ }),
    ).toBeVisible();

    const row = page.locator("tr").filter({ hasText: id });
    await expect(row, "the submission is listed under the namespace it was filed into").toHaveCount(
      1,
    );
    await row.getByRole("button", { name: "Approve…" }).click();

    // THE CONSEQUENCE IS STATED BEFORE THE BUTTON THAT CAUSES IT. Approving publishes a stranger's
    // account of this programme to the world in this organisation's name, and it is not undone by
    // clicking again — so it does not fire on the first click.
    const confirm = page.getByRole("group", { name: "Publish this listing?" });
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText(/anyone reading the Hub will see it as this organisation/i),
    ).toBeVisible();
    await confirm.getByRole("button", { name: "Publish it" }).click();

    await expect(page.getByRole("status").filter({ hasText: `${id} is published.` })).toBeVisible();

    // …and it MOVED, rather than the page merely saying so. The waiting list reloads on the spot,
    // so the decision controls go with the row immediately.
    await expect(
      page.locator("tr").filter({ hasText: id }).getByRole("button", { name: "Approve…" }),
      "a decided row leaves the waiting list",
    ).toHaveCount(0);

    // The PUBLISHED list is re-read on a reload rather than on the decision (only the queue the
    // decision came out of is refreshed in place), so this asks for it the way a member would.
    // A row here carries no decision controls, which is what tells the two tables apart.
    await page.reload();
    await expect(page.getByRole("heading", { name: /Published in this namespace/ })).toBeVisible();
    const published = page.locator("tr").filter({ hasText: id });
    await expect(published).toHaveCount(1);
    await expect(published.getByRole("button")).toHaveCount(0);

    // THE DECISIVE HALF: a stranger with no account can now read it in the public directory. The
    // member's click is only real if it changed what the world sees.
    const { context, page: visitor } = await anonymous(browser);
    try {
      await visitor.goto(`${stack.urls.frontend}?q=${encodeURIComponent(token)}`);
      await expect(
        visitor.getByRole("link", { name: `Filed by an outsider ${token}` }),
        "an approved entry is in the public directory, for everyone",
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("refusing needs a written reason, hides the listing, and tells the submitter why", async ({
    page,
    browser,
    stack,
    api,
    contextAs,
    opportunityFixture,
  }) => {
    const slug = stack.namespaces.publisher;
    const outsider = await api("otherPublisher");
    const stamp = Date.now();
    const token = `orgreject${stamp}`;
    const reason = `Not ours — we have never run this programme (${token}).`;

    const document = opportunityFixture(slug, `org-reject-${stamp}`, {
      title: `Filed in error ${token}`,
    });
    const id = document.id as string;
    expect((await outsider.post("/v1/opportunities", document)).status).toBe(201);

    await page.goto(`${stack.urls.frontend}/organisations/${encodeURIComponent(slug)}`);
    const row = page.locator("tr").filter({ hasText: id });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Reject…" }).click();

    const confirm = page.getByRole("group", { name: "Refuse this listing?" });
    await expect(confirm).toBeVisible();

    // A REASON IS REQUIRED, AND THE UI REFUSES BEFORE THE API HAS TO. The API answers 400
    // `reason_required` for an empty one and that is the authority — but a form that lets somebody
    // press the button and then explains is a form that made them fail first. The control is
    // disabled until there is something to send.
    const refuse = confirm.getByRole("button", { name: "Refuse it" });
    await expect(refuse, "an empty reason cannot be submitted").toBeDisabled();
    // Whitespace is not a reason either: the check is on the trimmed value.
    await confirm.getByLabel("Reason").fill("   ");
    await expect(refuse, "and neither is whitespace").toBeDisabled();

    await confirm.getByLabel("Reason").fill(reason);
    await expect(refuse).toBeEnabled();
    await refuse.click();

    await expect(page.getByRole("status").filter({ hasText: `${id} was refused.` })).toBeVisible();

    // It is out of the public reads. The directory is the surface a reader actually uses, so that
    // is where the absence is checked rather than in an API status code.
    const { context, page: visitor } = await anonymous(browser);
    try {
      await visitor.goto(`${stack.urls.frontend}?q=${encodeURIComponent(token)}&status=any`);
      await expect(
        visitor.getByRole("link", { name: `Filed in error ${token}` }),
        "a refused entry stays out of the public directory, whatever the status filter says",
      ).toHaveCount(0);
    } finally {
      await context.close();
    }

    // THE SUBMITTER IS TOLD WHY, IN THEIR OWN LIST. A refusal with no reason attached to it was the
    // worst state this product had: the word `rejected` on a listing and nothing that said what to
    // fix. `lastDecision` carries the sentence and `/listings` is where its author reads it — which
    // needs a browser signed in as THAT account, not as the organisation that refused it.
    const submitterContext = await contextAs("otherPublisher");
    const submitterPage = await submitterContext.newPage();
    await submitterPage.goto(`${stack.urls.frontend}/listings`);
    const refused = submitterPage.locator("tr").filter({ hasText: id });
    await expect(refused).toHaveCount(1);
    await expect(refused.getByText("Not published.")).toBeVisible();
    await expect(
      refused.getByText(reason, { exact: false }),
      "the reason the organisation wrote is the reason its author reads",
    ).toBeVisible();
  });
});

/**
 * The boundaries of the route, which no component test can reach.
 *
 * Each of these is a fact about a row, a membership and a slug at once. A component can be told
 * that a decision was refused; only a real request against a real row can establish that the
 * refusal is a 404 rather than a 403, and that difference is the entire anti-enumeration property.
 */
test.describe("M3-8 what a member may decide, and about what", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "otherPublisher", "reviewer");
  });

  test("a listing in another organisation's namespace is not there, rather than forbidden", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const mine = stack.namespaces.publisher;
    const theirs = stack.namespaces.other;
    const publisher = await api("publisher");
    const outsider = await api("otherPublisher");

    // A real row, published under the OTHER organisation's namespace by its own verified member.
    const elsewhere = opportunityFixture(theirs, `org-elsewhere-${Date.now()}`);
    const elsewhereId = elsewhere.id as string;
    expect((await outsider.post("/v1/opportunities", elsewhere)).status).toBe(201);

    // 404, NOT 403. The publisher IS a verified member of `mine`, so the membership gate passes and
    // the route still refuses — because the row is not published under `mine`. A 403 here would
    // confirm the id exists, which is an existence oracle over another organisation's queue, one
    // guess at a time.
    const crossNamespace = await publisher.post<{ error: string }>(
      `/v1/organizations/${encodeURIComponent(mine)}/opportunities/${encodeURIComponent(elsewhereId)}/approve`,
    );
    expect(
      crossNamespace.status,
      "a row under another namespace is not there, as far as this route is concerned",
    ).toBe(404);

    // …and the other spelling of the same attempt — asking the OTHER organisation directly — is a
    // 403 about the membership rather than a 404 about the row. The two refusals answer different
    // questions and must not be collapsed: organisations are a public directory, their queues are
    // not.
    const notAMember = await publisher.post<{ error: string }>(
      `/v1/organizations/${encodeURIComponent(theirs)}/opportunities/${encodeURIComponent(elsewhereId)}/approve`,
    );
    expect(notAMember.status).toBe(403);
    expect(notAMember.body.error).toBe("not_a_verified_member");

    // The same pair for the refusal route, whose guards are deliberately identical to approve's — a
    // route pair whose guards drifted apart would be the interesting bug.
    const rejectCross = await publisher.post<{ error: string }>(
      `/v1/organizations/${encodeURIComponent(mine)}/opportunities/${encodeURIComponent(elsewhereId)}/reject`,
      { reason: "should never be recorded" },
    );
    expect(rejectCross.status).toBe(404);
  });

  test("the decision names the member who made it, and is marked as the organisation's own", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const slug = stack.namespaces.publisher;
    const publisher = await api("publisher");
    const outsider = await api("otherPublisher");
    const reviewer = await api("reviewer");
    const stamp = Date.now();

    const handle = await ensureHandle(publisher, `e2e-member-${stack.runId.toLowerCase()}`);

    const filed = opportunityFixture(slug, `org-audit-${stamp}`);
    const filedId = filed.id as string;
    expect((await outsider.post("/v1/opportunities", filed)).status).toBe(201);

    const decided = await publisher.post(
      `/v1/organizations/${encodeURIComponent(slug)}/opportunities/${encodeURIComponent(filedId)}/approve`,
    );
    expect(decided.status).toBe(200);

    // THE ENTITLED READ, which carries the patch. The public one deliberately does not — it says
    // which fields moved and never their values — so the distinguisher this criterion is about is
    // only visible to somebody entitled to it.
    const trail = await publisher.get<{
      entries: Array<{ action: string; actor: string; patch?: Record<string, unknown> }>;
    }>(`/v1/opportunities/${encodeURIComponent(filedId)}/audit`);
    expect(trail.status).toBe(200);
    const approval = trail.body.entries.find((entry) => entry.action === "approve");
    expect(approval, "the approval is in the trail").toBeDefined();

    // NAMED, NOT COARSENED. A Hub reviewer's decision is attributed to "reviewer" because the
    // person behind it is acting as the Hub. A member deciding in their own organisation's name is
    // the opposite case: the whole counterweight to the conflict of interest is that it is THEIR
    // decision, so the trail carries their handle.
    expect(approval?.actor, "an organisation's own decision names the member").toBe(handle);
    expect(
      (approval?.patch as { via?: string } | undefined)?.via,
      "…and is marked as the organisation's own act rather than the Hub's",
    ).toBe("operating_org");

    // The database agrees about WHO, independently of how the view renders it — a handle can be
    // changed, an account id is the join everything else keys on.
    const rows = await db.query<{ actor_kind: string; actor_account_id: string | null }>(
      `SELECT a.actor_kind, a.actor_account_id FROM audit_log a
         JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'approve'`,
      [filedId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.actor_kind).toBe("user");
    expect(Number(rows.rows[0]?.actor_account_id)).toBe(stack.actors.publisher?.accountId);

    // THE CONTRAST, on an equivalent row: the same verb, decided by the Hub instead, is attributed
    // to the role. Without this the assertion above would pass on an API that simply printed
    // whatever handle it had.
    const byTheHub = opportunityFixture(slug, `hub-audit-${stamp}`);
    const hubId = byTheHub.id as string;
    expect((await outsider.post("/v1/opportunities", byTheHub)).status).toBe(201);
    expect(
      // `{}` rather than no payload: this route declares a body schema (an optional `reason`), and
      // Fastify answers 400 for a POST with no body at all against one.
      (await reviewer.post(`/v1/review/opportunities/${encodeURIComponent(hubId)}/approve`, {}))
        .status,
    ).toBe(200);

    const hubTrail = await publisher.get<{
      entries: Array<{ action: string; actor: string; patch?: Record<string, unknown> }>;
    }>(`/v1/opportunities/${encodeURIComponent(hubId)}/audit`);
    const hubApproval = hubTrail.body.entries.find((entry) => entry.action === "approve");
    expect(hubApproval?.actor, "a Hub decision is the Hub's, not a named person's").toBe(
      "reviewer",
    );
    expect((hubApproval?.patch as { via?: string } | undefined)?.via).not.toBe("operating_org");
  });

  test("an unverified account cannot decide in a namespace it does not belong to", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    skipUnlessActor(stack, "submitter");
    const slug = stack.namespaces.publisher;
    const outsider = await api("otherPublisher");
    const submitter = await api("submitter");

    const filed = opportunityFixture(slug, `org-outsider-${Date.now()}`);
    const filedId = filed.id as string;
    expect((await outsider.post("/v1/opportunities", filed)).status).toBe(201);

    // The membership is the gate, and a plain account holds none — so it is refused about a row it
    // can otherwise see nothing of. 403 rather than 404 here because the ORGANISATION exists and is
    // public; it is its queue that is not.
    const refused = await submitter.post<{ error: string }>(
      `/v1/organizations/${encodeURIComponent(slug)}/opportunities/${encodeURIComponent(filedId)}/approve`,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_a_verified_member");

    // …and it cannot read the queue either, which is the gate on the list route. Same organisation,
    // different capability: ANY membership would be enough to look, and this account has none.
    const cannotLook = await submitter.get<{ error: string }>(
      `/v1/organizations/${encodeURIComponent(slug)}/opportunities?reviewStatus=pending`,
    );
    expect(cannotLook.status).toBe(403);
    expect(cannotLook.body.error).toBe("not_a_member");
  });
});

/**
 * How a membership comes into existence in the first place.
 *
 * EVERYTHING ELSE IN THIS FILE PRESUPPOSES ONE, and the suite's own bring-up grants them over HTTP.
 * That is fine for provisioning and useless as evidence: the control a reviewer actually uses is on
 * the review surface, it resolves a HANDLE to the account id the API wants, and it states a
 * different consequence depending on whether the organisation is verified. None of that is
 * exercised by a POST from a provisioning script.
 *
 * THE ORGANISATION HERE IS DELIBERATELY UNVERIFIED. Granting on a verified one would hand the
 * grantee publish authority over a namespace and change what later assertions in this run mean; on
 * an unverified one the grant is real and its consequence is the narrower of the two, which is also
 * the wording this test pins.
 */
test.describe("M3-8 a reviewer grants a membership", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("a reviewer finds an account by handle and makes it a member, with the consequence stated", async ({
    stack,
    api,
    contextAs,
    opportunityFixture,
  }) => {
    const stamp = Date.now();
    const publisher = await api("publisher");

    // An organisation comes into existence as a directory STUB when an entry naming it is
    // submitted — there is no organisation-creation endpoint, and that is the product's design
    // rather than this harness's shortcut. This one has no members and is not verified.
    const slug = `${stack.namespaces.publisher}-grant`;
    const seed = opportunityFixture(slug, `grant-seed-${stamp}`, {
      title: `Stub organisation seed ${stamp}`,
    });
    expect((await publisher.post("/v1/opportunities", seed)).status).toBe(201);

    // The account to be granted: a fresh identity, so nothing else in the run depends on what it
    // ends up holding. It needs a handle, because a handle is what a reviewer reading a claim
    // actually knows — the API takes an account id and this control exists to bridge the two.
    const grantee = await freshIdentity(stack, "grantee");
    const granteeClient = new ApiClient({
      baseUrl: stack.urls.api,
      token: grantee.token,
      userAgent: DESKTOP_UA,
    });
    const handle = await ensureHandle(granteeClient, `e2e-grantee-${stack.runId.toLowerCase()}`);
    expect(
      (await granteeClient.get<{ memberships: unknown[] }>("/v1/me")).body.memberships,
      "the grantee starts with no membership, or this proves nothing",
    ).toEqual([]);

    const context = await contextAs("reviewer");
    const page = await context.newPage();
    await page.goto(`${stack.urls.frontend}/review?tab=organisations`);

    // SEARCH-FIRST, AND THAT IS A SAFETY PROPERTY. The directory auto-registers a stub for every
    // organisation any listing merely names, so an unfiltered list is hundreds of names nobody has
    // vouched for. A stub is reachable only through a deliberate search.
    await page.getByLabel("Search organisations by name or slug").fill(slug);
    await page.getByRole("button", { name: "Search", exact: true }).click();

    const row = page.locator("tr").filter({ hasText: slug });
    await expect(row, "the stub is found by its slug").toHaveCount(1);
    await expect(
      row.getByText(/verifying grants nothing today and arms whoever is added next/i),
      "a memberless stub says what verifying it would really do",
    ).toBeVisible();

    // The grant panel opens in a table row of ITS OWN, under the organisation's row — so its
    // controls are addressed page-wide rather than through `row`, which is the organisation's row
    // and does not contain them.
    await row.getByRole("button", { name: "Grant a membership…" }).click();
    await expect(page.getByText("Grant a membership on")).toBeVisible();

    await page.getByLabel("Account handle or id").fill(handle);
    await page.getByRole("button", { name: "Find the account" }).click();
    await expect(page.getByRole("status").filter({ hasText: handle })).toBeVisible();
    await page.getByRole("button", { name: "Choose" }).first().click();

    // SAME BUTTON, TWO VERY DIFFERENT CONSEQUENCES, and they are never worded the same way. This
    // organisation is not verified, so the grant is permission to submit into the namespace and
    // nothing more — and the panel says exactly that before it is confirmed.
    const confirm = page.getByRole("group", {
      name: `Make ${handle} a publisher of ${slug}?`,
    });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/still wait for a reviewer/i)).toBeVisible();
    await confirm.getByRole("button", { name: "Grant the membership" }).click();

    // THE PANEL CLOSES, THE CONFIRMATION SURVIVES IT, AND THE ROW UPDATES.
    //
    // The middle one used to be missing: the sentence was composed and then dropped, because
    // confirming unmounted the component whose state held it. The grant worked and said nothing.
    // It now runs through the PARENT's action — the same one verify and withdraw use — whose note
    // sits above the table and outlives any row's panel.
    await expect(
      page.getByText("Grant a membership on"),
      "the panel closes once the grant is made",
    ).toHaveCount(0);
    await expect(
      page.getByText(`${handle} is now publisher of ${slug}.`),
      "the API's confirmation outlives the panel that triggered it",
    ).toBeVisible();
    await expect(
      page
        .locator("tr")
        .filter({ hasText: slug })
        .first()
        .getByRole("cell", { name: "1", exact: true }),
      "the organisation is no longer memberless, which is the reviewer's visible outcome",
    ).toBeVisible();

    // THE ACCOUNT SEES IT, which is the only version of "granted" that matters: `/v1/me` is what
    // every capability decision downstream is made from, and what the frontend renders navigation
    // from. Unverified, because the organisation is — the membership is real and the publishing
    // right is not.
    const after = await granteeClient.get<{
      memberships: Array<{ slug: string; role: string; verified: boolean }>;
    }>("/v1/me");
    expect(after.status).toBe(200);
    expect(after.body.memberships).toContainEqual(
      expect.objectContaining({ slug, role: "publisher", verified: false }),
    );
  });
});
