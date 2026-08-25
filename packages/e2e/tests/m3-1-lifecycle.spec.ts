import {
  DESKTOP_UA,
  PENDING_SUBMISSION_LIMIT,
  expect,
  freshIdentity,
  skipUnlessActor,
  test,
} from "../src/fixtures.js";
/**
 * M3-1 — the publisher lifecycle, over real HTTP.
 *
 * The first two criteria of this area (just-in-time provisioning and the administrator bootstrap)
 * live in `00-acceptance.setup.ts`, because each is an assertion about an identity's FIRST EVER
 * request and there is exactly one of those per identity. Everything that follows from an existing
 * account is here.
 *
 * One criterion in this area is recorded as not machine-verifiable rather than tested: the "apply
 * to become a publisher" step is a human process (an issue against the repository, per
 * `PUBLISHERS.md`). There is no endpoint, so there is nothing an end-to-end suite could exercise —
 * and a test that pretended otherwise would be testing a fiction.
 */
import { ApiClient } from "../src/http.js";

test.describe.configure({ mode: "serial" });

test.describe("M3-1 roles and their effects", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "admin", "submitter");
  });

  test("an administrator promotes an account to reviewer, and the promotion takes effect", async ({
    stack,
    api,
  }) => {
    const admin = await api("admin");
    const target = stack.actors.submitter;
    if (!target?.accountId) throw new Error("the submitter's account id was not provisioned");

    const promoted = await admin.post<{ id: number; globalRole: string }>(
      `/v1/admin/accounts/${target.accountId}/role`,
      { role: "reviewer" },
    );
    expect(promoted.status).toBe(200);
    expect(promoted.body.globalRole).toBe("reviewer");

    // The promotion is only real if the account SEES it. `/v1/me` is what the frontend renders its
    // navigation from and what every later capability decision reads.
    const promotedSelf = await (await api("submitter")).get<{ role: string; canReview: boolean }>(
      "/v1/me",
    );
    expect(promotedSelf.body.role).toBe("reviewer");
    expect(promotedSelf.body.canReview).toBe(true);

    // …and the reviewer surface actually opens.
    const queue = await (await api("submitter")).get("/v1/review/opportunities");
    expect(queue.status).toBe(200);

    // Demotion, and the effect on the very next request. A role that is easy to grant and slow to
    // revoke is the shape of an incident.
    const demoted = await admin.post<{ globalRole: string }>(
      `/v1/admin/accounts/${target.accountId}/role`,
      { role: "submitter" },
    );
    expect(demoted.status).toBe(200);
    expect(demoted.body.globalRole).toBe("submitter");

    const afterDemotion = await (await api("submitter")).get<{ error: string }>(
      "/v1/review/opportunities",
    );
    expect(afterDemotion.status, "the very next reviewer request must be refused").toBe(403);
    expect(afterDemotion.body.error).toBe("forbidden");
  });

  test("a non-administrator cannot change anyone's role", async ({ stack, api }) => {
    const submitter = await api("submitter");
    const adminAccountId = stack.actors.admin?.accountId;
    if (!adminAccountId) throw new Error("the administrator's account id was not provisioned");

    const attempt = await submitter.post<{ error: string }>(
      `/v1/admin/accounts/${adminAccountId}/role`,
      {
        role: "submitter",
      },
    );
    expect(attempt.status).toBe(403);
    expect(attempt.body.error).toBe("forbidden");
  });
});

test.describe("M3-1 API keys", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  test("a key is created by a session, its secret is shown once, and it never appears again", async ({
    api,
    keyClient,
  }) => {
    const publisher = await api("publisher");
    const created = await keyClient("publisher", ["read", "write"]);

    // The secret came back on the create response — the only time it exists outside the client.
    expect(created.token).toMatch(/^rfph_[a-z0-9]{8}_[A-Za-z0-9_-]{16,}$/);

    const listed = await publisher.get<{ items: Array<Record<string, unknown>> }>("/v1/keys");
    expect(listed.status).toBe(200);
    const mine = listed.body.items.find((item) => item.id === created.keyId);
    expect(mine, "the key is listed").toBeDefined();
    // The listing carries the public prefix and NOTHING that could reconstruct the credential.
    expect(mine).toMatchObject({ keyPrefix: created.keyPrefix });
    expect(JSON.stringify(listed.body)).not.toContain(created.token);
  });

  test("a key cannot mint another key", async ({ keyClient }) => {
    const created = await keyClient("publisher", ["read", "write", "publish"]);
    const attempt = await created.client.post<{ error: string }>("/v1/keys", {
      name: "escalation",
      scopes: ["publish"],
    });
    // This is the containment that matters after a key leaks: the leaked credential cannot mint a
    // stronger, longer-lived one.
    expect(attempt.status).toBe(403);
    expect(attempt.body.error).toBe("session_required");
  });

  test("scopes are enforced on the write surface", async ({
    stack,
    keyClient,
    opportunityFixture,
  }) => {
    const readOnly = await keyClient("publisher", ["read"]);
    const refused = await readOnly.client.post<{ error: string }>(
      "/v1/opportunities",
      opportunityFixture(stack.namespaces.publisher, `scope-${Date.now()}`),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("missing_scope");

    // `write` without `publish` lands PENDING even for a verified publisher: the scope, not the
    // account's standing, is what decides whether a credential may publish immediately.
    const writeOnly = await keyClient("publisher", ["write"]);
    const written = await writeOnly.client.post<{ reviewStatus: string; isListed: boolean }>(
      "/v1/opportunities",
      opportunityFixture(stack.namespaces.publisher, `writeonly-${Date.now()}`),
    );
    expect(written.status).toBe(201);
    expect(written.body.reviewStatus, "a write-only key may submit, never publish").toBe("pending");
  });

  test("revocation takes effect on the next request, and one account never sees another's keys", async ({
    api,
    keyClient,
  }) => {
    const publisher = await api("publisher");
    const victim = await keyClient("publisher", ["read"]);

    const before = await victim.client.get("/v1/me");
    expect(before.status).toBe(200);

    const revoked = await publisher.delete(`/v1/keys/${victim.keyId}`);
    expect(revoked.status).toBe(200);

    const after = await victim.client.get<{ error: string }>("/v1/me");
    expect(after.status, "a revoked key must stop working immediately").toBe(401);
    expect(after.body.error).toBe("unauthorized");
  });

  test("deleting another account's key answers 404, never 403", async ({
    stack,
    api,
    keyClient,
  }) => {
    test.skip(
      !stack.actors.otherPublisher && !stack.actors.submitter,
      "BLOCKED: cross-account key isolation needs a second identity, and none was established.",
    );
    const otherName = stack.actors.otherPublisher ? "otherPublisher" : "submitter";
    const mine = await keyClient("publisher", ["read"]);
    const other = await api(otherName);

    const attempt = await other.delete<{ error: string }>(`/v1/keys/${mine.keyId}`);
    // 404, not 403. A 403 would confirm the key id exists — an existence oracle over another
    // account's credentials, enumerable one integer at a time.
    expect(attempt.status).toBe(404);

    const theirList = await other.get<{ items: Array<{ id: number }> }>("/v1/keys");
    expect(theirList.body.items.map((item) => item.id)).not.toContain(mine.keyId);
  });
});

/**
 * The review queue is a shared resource, and one account may not fill it.
 *
 * WHY THIS RUNS AGAINST AN IDENTITY OF ITS OWN. The cap counts an account's CURRENTLY pending rows,
 * so an assertion about "the sixth" is an assertion about a number that every earlier file could
 * have moved. Driving it through the run's shared `submitter` would make the criterion depend on
 * execution order — the worst kind of flake, because it passes locally and fails in CI on a
 * reordering. Identities cost nothing here (`identity/sessions.ts`: created by using them,
 * offline), so this one starts at zero by construction.
 *
 * WHY THE SIXTH GOES THROUGH THE BROWSER AND THE FIRST FIVE DO NOT. The API's 409 is asserted by
 * the API's own integration suite. What only a browser can establish is that the sentence the API
 * wrote reaches the person who hit the limit, in the form they were typing into — rather than
 * becoming a generic "something went wrong" on the way. So five are seeded over HTTP in a second,
 * and one is typed.
 */
test.describe("M3-1 how many submissions may wait at once", () => {
  test("the sixth pending submission is refused in the form, and approving one frees the slot", async ({
    stack,
    api,
    contextAs,
    opportunityFixture,
  }) => {
    skipUnlessActor(stack, "reviewer");
    const stamp = Date.now();
    // A namespace of its own, so these fixtures cannot be mistaken for another spec's — and one
    // nobody is a member of, which is the situation the cap is actually about.
    const namespace = `${stack.namespaces.publisher}-cap`;

    const capped = await freshIdentity(stack, "capped");
    const client = new ApiClient({
      baseUrl: stack.urls.api,
      token: capped.token,
      userAgent: DESKTOP_UA,
    });

    // The account is created by its first request, and it holds no membership anywhere — which is
    // precisely who the cap applies to. A verified publisher is exempt, so an account with one
    // would prove the opposite of this criterion.
    const me = await client.get<{ accountId: number; memberships: unknown[] }>("/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.memberships, "the cap is for accounts with no verified membership").toEqual([]);

    const ids: string[] = [];
    for (let index = 0; index < PENDING_SUBMISSION_LIMIT; index++) {
      const document = opportunityFixture(namespace, `cap-${stamp}-${index}`, {
        // Distinct text per entry: five near-identical documents would be flagged as duplicates of
        // one another, which is a different criterion and not one this test wants to move.
        title: `Capped submission ${index} of ${stamp}`,
        description: `Submission number ${index} from an account with no verified membership, filed at ${stamp}.`,
      });
      const created = await client.post<{ reviewStatus: string }>("/v1/opportunities", document);
      expect(created.status, `submission ${index} is accepted`).toBe(201);
      expect(created.body.reviewStatus).toBe("pending");
      ids.push(document.id as string);
    }

    // ── the sixth, typed into the form the way a person meets this ────────────────────────────
    const context = await contextAs({ email: capped.email });
    const page = await context.newPage();
    await page.goto(`${stack.urls.frontend}/listings/new`);
    await expect(page.getByRole("heading", { name: "Submit an opportunity" })).toBeVisible();

    const sixthId = `${namespace}:cap-${stamp}-sixth`;
    await page.getByLabel(/^Title/).fill(`Capped submission six of ${stamp}`);
    await page
      .getByLabel(/^Description/)
      .fill("The sixth submission from an account that already has five waiting for review.");
    await page.getByLabel(/^Name/).fill(namespace);
    await page.getByLabel(/^Slug/).fill(namespace);
    await page.getByLabel(/^Application URL/).fill(stack.urls.programme);
    await page.getByLabel(/^Id\b/).fill(sixthId);

    const submit = page.getByRole("button", { name: "Submit", exact: true });
    await submit.click();

    // THE API'S OWN SENTENCE, VERBATIM. Not a paraphrase this frontend invented: the limit is
    // configurable, so the only number a reader can trust is the one the server put in the message.
    // A generic "something went wrong" here would leave somebody deleting drafts at random.
    await expect(
      page
        .getByRole("status")
        .getByText(
          new RegExp(
            `which is the limit of ${PENDING_SUBMISSION_LIMIT} for an account without a verified publisher membership`,
          ),
        ),
      "the form shows what the API said, including the number it enforced",
    ).toBeVisible();
    await expect(page.getByText(/pending_limit_reached/)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Submitted." }),
      "and nothing was stored",
    ).toHaveCount(0);

    // ── a decision frees a slot, exactly as the message promised ──────────────────────────────
    const reviewer = await api("reviewer");
    // The body is `{}` rather than absent: the route declares a body schema (an optional `reason`),
    // and Fastify answers 400 for a POST with no payload at all against one.
    const freed = await reviewer.post(
      `/v1/review/opportunities/${encodeURIComponent(ids[0] as string)}/approve`,
      {},
    );
    expect(freed.status, "a reviewer's decision is what frees a slot").toBe(200);

    // The SAME form, unchanged and still holding what was typed — pressing Submit again is the
    // whole of what the message told the publisher to do.
    await submit.click();
    await expect(
      page.getByRole("heading", { name: "Submitted." }),
      "with a slot free, the same submission is accepted",
    ).toBeVisible();

    // `GET /v1/me/opportunities/:id` answers the STANDARD document — an owner reading their own
    // entry gets the record, not the Hub's review bookkeeping — so the row's existence is checked
    // here and its review state through the owner's list, which is where that lives.
    const stored = await client.get<{ id: string }>(
      `/v1/me/opportunities/${encodeURIComponent(sixthId)}`,
    );
    expect(stored.status, "the entry the form finally sent exists at the API").toBe(200);
    expect(stored.body.id).toBe(sixthId);

    // …and the queue is at the limit again, which is what "the freed slot was reused" means: the
    // cap is a ceiling on what is waiting, not a quota on a lifetime.
    const queue = await client.get<{ total: number }>(
      "/v1/me/opportunities?reviewStatus=pending&limit=1",
    );
    expect(queue.status).toBe(200);
    expect(queue.body.total, "one out, one in").toBe(PENDING_SUBMISSION_LIMIT);
  });
});
