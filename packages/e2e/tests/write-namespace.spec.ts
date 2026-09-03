/**
 * M3-2 — the write path, the namespace decision, and provenance the client does not get to set.
 *
 * The shape of this area: WHO may write WHERE, and what the server keeps for itself. Two of its
 * criteria (the concurrent-replace race and the full re-derivation of the decision under lock) are
 * asserted at the integration layer instead, with a deterministic barrier — see
 * `packages/api/test/integration/write-concurrency.test.ts`. A race cannot be proven by repetition
 * over HTTP; the HTTP case here is a smoke test that the same path works under real concurrency,
 * and it says so.
 */
import { expect, skipUnlessActor, test } from "../src/fixtures.js";
import type { ApiClient } from "../src/http.js";
import { me } from "../src/identity/actors.js";
import type { ActorName } from "../src/state.js";

test.describe.configure({ mode: "serial" });

test.describe("M3-2 who may publish, and where", () => {
  // Only what EVERY test here uses. The one case that needs an unaffiliated account declares that
  // for itself, so a tenant with a single identity still exercises the rest of the write path
  // instead of losing the whole group to one test's requirement.
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("a plain submitter's entry is pending, invisible publicly, and visible to its author", async ({
    stack,
    api,
    anonApi,
    pendingHeadroom,
    opportunityFixture,
  }) => {
    // This one genuinely needs an account with NO verified membership — that absence is the whole
    // criterion, and no privileged actor can stand in for it.
    skipUnlessActor(stack, "submitter");
    // The same absence is what the pending cap applies to, so the queue slot has to be there before
    // this can assert anything about the entry. The cap itself is `lifecycle.spec.ts`'s criterion.
    await pendingHeadroom("submitter", 1);
    const submitter = await api("submitter");
    const document = opportunityFixture(stack.namespaces.publisher, `submitter-${Date.now()}`);
    const id = document.id as string;

    const created = await submitter.post<{ reviewStatus: string; isListed: boolean }>(
      "/v1/opportunities",
      document,
    );
    expect(created.status).toBe(201);
    expect(created.body.reviewStatus, "an unaffiliated submission is never auto-published").toBe(
      "pending",
    );

    const publicly = await anonApi.get(`/v1/opportunities/${encodeURIComponent(id)}`);
    expect(publicly.status, "a pending entry is not publicly readable").toBe(404);

    const toItsAuthor = await submitter.get(`/v1/me/opportunities/${encodeURIComponent(id)}`);
    expect(toItsAuthor.status, "its author can always see their own entry").toBe(200);
  });

  test("a verified publisher's entry inside its own namespace is published, with an audited approval", async ({
    stack,
    api,
    anonApi,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `auto-${Date.now()}`);
    const id = document.id as string;

    const created = await publisher.post<{ reviewStatus: string; isListed: boolean }>(
      "/v1/opportunities",
      document,
    );
    expect(created.status).toBe(201);
    expect(created.body.reviewStatus).toBe("approved");
    expect(created.body.isListed).toBe(true);

    const publicly = await anonApi.get(`/v1/opportunities/${encodeURIComponent(id)}`);
    expect(publicly.status).toBe(200);

    // Two audit rows, not one: the creation and the approval are separate facts, and the approval
    // records WHY it happened without a human having decided it.
    const trail = await publisher.get<{
      entries: Array<{ action: string; patch?: Record<string, unknown> }>;
    }>(`/v1/opportunities/${encodeURIComponent(id)}/audit`);
    expect(trail.status).toBe(200);
    const actions = trail.body.entries.map((entry) => entry.action);
    expect(actions).toContain("create");
    expect(actions).toContain("approve");
    const approval = trail.body.entries.find((entry) => entry.action === "approve");
    expect(JSON.stringify(approval?.patch ?? {})).toContain("verified_publisher_namespace");
  });

  test("the same publisher writing into someone else's namespace lands pending", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.other, `crossns-${Date.now()}`);

    const created = await publisher.post<{ reviewStatus: string }>("/v1/opportunities", document);
    expect(created.status).toBe(201);
    // Publish authority is per NAMESPACE, not per account. A verified publisher is not a
    // verified publisher of everything.
    expect(created.body.reviewStatus).toBe("pending");
  });

  test("a publisher that is not among the entry's operating organizations is refused", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `notoperating-${Date.now()}`, {
      // The namespace claims one organization while the operating list names a different one.
      operatingOrganizations: [{ name: "Some Other Body", slug: `${stack.namespaces.other}-body` }],
    });

    const refused = await publisher.post<{ error: string }>("/v1/opportunities", document);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("publisher_not_operating");
  });
});

test.describe("M3-2 publish authority is revocable", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("unverifying the organization turns auto-publish off, and re-verifying turns it back on", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    // The RESET half of publish authority. Granting it is exercised everywhere; taking it away is
    // the half that matters after a mistaken verification or a publisher that has to be stood down,
    // and it has to take effect on the very NEXT write rather than at some later refresh.
    const publisher = await api("publisher");
    const reviewer = await api("reviewer");
    const namespace = stack.namespaces.publisher;

    const before = await publisher.post<{ reviewStatus: string }>(
      "/v1/opportunities",
      opportunityFixture(namespace, `authority-on-${Date.now()}`),
    );
    expect(before.status).toBe(201);
    expect(before.body.reviewStatus, "a verified publisher auto-publishes to begin with").toBe(
      "approved",
    );

    expect((await reviewer.post(`/v1/review/organizations/${namespace}/unverify`, {})).status).toBe(
      200,
    );

    // The account still holds the membership — what changed is the organization's standing, and
    // `hasVerifiedMembership` reads both. The next write must land pending.
    const during = await publisher.post<{ reviewStatus: string }>(
      "/v1/opportunities",
      opportunityFixture(namespace, `authority-off-${Date.now()}`),
    );
    expect(during.status).toBe(201);
    expect(during.body.reviewStatus, "unverification must bite on the very next write").toBe(
      "pending",
    );

    const self = await me(publisher);
    expect(self.memberships).toContainEqual(
      expect.objectContaining({ slug: namespace, verified: false }),
    );

    // …and it is reversible, which is what makes it a reset rather than a one-way door. Restored
    // here also because every later spec in the run expects this publisher to be verified.
    expect((await reviewer.post(`/v1/review/organizations/${namespace}/verify`, {})).status).toBe(
      200,
    );
    const after = await publisher.post<{ reviewStatus: string }>(
      "/v1/opportunities",
      opportunityFixture(namespace, `authority-back-${Date.now()}`),
    );
    expect(after.status).toBe(201);
    expect(after.body.reviewStatus, "re-verification restores it just as directly").toBe(
      "approved",
    );
  });
});

test.describe("M3-2 provenance belongs to the server", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher");
  });

  test("a client cannot forge who submitted an entry, when, or how it arrived", async ({
    stack,
    api,
    pendingHeadroom,
    opportunityFixture,
  }) => {
    // Deliberately an unaffiliated account: `source.originalId` is forced null only for a credential
    // that cannot publish in the namespace, so a privileged actor would not exercise that clause.
    skipUnlessActor(stack, "submitter");
    await pendingHeadroom("submitter", 1);
    const submitter = await api("submitter");
    const before = new Date(Date.now() - 60_000);

    const document = opportunityFixture(stack.namespaces.publisher, `forged-${Date.now()}`, {
      source: {
        publisher: stack.namespaces.publisher,
        submittedBy: "somebody-else",
        submittedAt: "2001-01-01T00:00:00.000Z",
        ingestedVia: "import",
        verifiedAgainstSource: true,
        snapshotUrl: "https://example.invalid/archive/forged",
        originalId: "forged-original-id",
      },
    });

    const created = await submitter.post<{ opportunity: { source: Record<string, unknown> } }>(
      "/v1/opportunities",
      document,
    );
    expect(created.status).toBe(201);
    const source = created.body.opportunity.source;

    // Every one of these is a claim about how the record came to exist. Accepting any of them from
    // the client would make the provenance a self-report — which is exactly what it must not be.
    expect(source.submittedAt, "the server stamps the time").not.toBe("2001-01-01T00:00:00.000Z");
    expect(new Date(String(source.submittedAt)).getTime()).toBeGreaterThan(before.getTime());
    expect(source.ingestedVia, "the server decides how this arrived").toBe("submission");
    expect(source.verifiedAgainstSource, "verification is a server-side finding").not.toBe(true);
    // `snapshot_url` is an external-archive pointer that no route populates in this milestone. The
    // criterion asserted here is the only one available: a submitter can never populate it.
    expect(
      source.snapshotUrl ?? null,
      "a submitter cannot populate the archive pointer",
    ).toBeNull();
    expect(
      source.originalId ?? null,
      "a credential that cannot publish here cannot claim an upstream id",
    ).toBeNull();
  });

  test("a replace preserves identity and history and cannot rename the entry", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `replace-${Date.now()}`);
    const id = document.id as string;

    const created = await publisher.post<{ opportunity: { source: Record<string, unknown> } }>(
      "/v1/opportunities",
      document,
    );
    expect(created.status).toBe(201);
    const originalSource = created.body.opportunity.source;

    const replaced = await publisher.put<{
      opportunity: { id: string; title: string; source: Record<string, unknown> };
    }>(`/v1/opportunities/${encodeURIComponent(id)}`, {
      ...document,
      title: "A revised fixture title",
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.opportunity.id).toBe(id);
    expect(replaced.body.opportunity.title).toBe("A revised fixture title");
    // The submission facts are the record's history and a replace is not a new submission.
    expect(replaced.body.opportunity.source.submittedAt).toBe(originalSource.submittedAt);
    expect(replaced.body.opportunity.source.submittedBy).toBe(originalSource.submittedBy);

    const trail = await publisher.get<{ entries: Array<{ action: string }> }>(
      `/v1/opportunities/${encodeURIComponent(id)}/audit`,
    );
    const actions = trail.body.entries.map((entry) => entry.action);
    expect(actions).toContain("update");
    expect(actions, "earlier history survives a replace").toContain("create");

    // A body whose id differs from the path is a rename attempt, and an id is the one thing a
    // record cannot change: every external reference to it would silently retarget.
    const renamed = await publisher.put<{ error: string }>(
      `/v1/opportunities/${encodeURIComponent(id)}`,
      {
        ...document,
        id: `${stack.namespaces.publisher}:renamed-${Date.now()}`,
      },
    );
    expect(renamed.status).toBe(400);
    expect(renamed.body.error).toBe("id_immutable");
  });

  test("a replace cannot strip the operating organization off a submitted entry", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `strip-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const stripped = await publisher.put<{ error: string }>(
      `/v1/opportunities/${encodeURIComponent(id)}`,
      {
        ...document,
        operatingOrganizations: [
          { name: "Unrelated Body", slug: `${stack.namespaces.other}-unrelated` },
        ],
      },
    );
    // Otherwise a publisher could edit an entry out of its own namespace and keep writing to it —
    // the containment check would then be a one-time gate rather than an invariant.
    expect(stripped.status).toBe(400);
    expect(stripped.body.error).toBe("publisher_not_operating");
  });

  test("two simultaneous replaces leave one coherent record and a chained audit trail", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    // SMOKE ONLY. The authoritative proof of this fix is barrier-deterministic and lives at
    // packages/api/test/integration/write-concurrency.test.ts: an interleaving cannot be
    // established by firing two requests and hoping. What this shows is that the real HTTP path
    // survives real concurrency without corrupting the record.
    const publisher = await api("publisher");
    const document = opportunityFixture(stack.namespaces.publisher, `race-${Date.now()}`);
    const id = document.id as string;
    expect((await publisher.post("/v1/opportunities", document)).status).toBe(201);

    const path = `/v1/opportunities/${encodeURIComponent(id)}`;
    const [first, second] = await Promise.all([
      publisher.put<{ opportunity: { title: string } }>(path, { ...document, title: "Writer one" }),
      publisher.put<{ opportunity: { title: string } }>(path, { ...document, title: "Writer two" }),
    ]);
    expect([first.status, second.status].every((status) => status === 200)).toBe(true);

    const stored = await publisher.get<{ title: string }>(
      `/v1/me/opportunities/${encodeURIComponent(id)}`,
    );
    expect(["Writer one", "Writer two"]).toContain(stored.body.title);

    // THE CHAIN IS READ FROM THE DATABASE, ORDERED BY audit_log.id, and that detail is the whole
    // reason this assertion is trustworthy.
    //
    // The API returns the trail ordered by `(created_at DESC, id DESC)`, and `created_at` defaults
    // to `now()` — which in PostgreSQL is the TRANSACTION START time. Two concurrent replaces
    // therefore carry timestamps in the order they BEGAN, not the order they committed: the writer
    // that blocked on `FOR UPDATE` started first and committed second, so ordering by time presents
    // the pair backwards and a correct chain reads as broken. (Observed exactly once in a real run,
    // which is what prompted this note.) `id` is assigned when the row is inserted — inside the
    // transaction, after the lock was won — so it is the only field that reflects true sequence.
    const chain = await db.query<{ patch: { title?: { before?: string; after?: string } } }>(
      `SELECT a.patch FROM audit_log a
         JOIN opportunities o ON o.id = a.subject_id
        WHERE o.public_id = $1 AND a.subject_kind = 'opportunity' AND a.action = 'update'
        ORDER BY a.id ASC`,
      [id],
    );
    const updates = chain.rows.filter((row) => row.patch?.title);

    // Asserted BEFORE the loop below, which starts at index 1 and would otherwise pass having
    // checked nothing at all if a row were missing.
    expect(updates.length, "each accepted replace must have recorded an audited title change").toBe(
      2,
    );

    for (let index = 1; index < updates.length; index++) {
      // The handoff: each write computed its diff from the row as it ACTUALLY was, which is only
      // possible if it re-read under the lock rather than from a snapshot taken before the other
      // writer committed.
      expect(
        updates[index]?.patch?.title?.before,
        "each update's `before` must be the previous update's `after`",
      ).toBe(updates[index - 1]?.patch?.title?.after);
    }
  });
});

/**
 * M3-2 claims — taking over an entry somebody else submitted.
 *
 * TWO FACTS ABOUT THE CLAIM PATH SHAPE EVERY FIXTURE BELOW, and getting either wrong makes the test
 * assert nothing:
 *
 *   1. A claim resolves the entry through the PUBLIC lookup, so it 404s on anything not
 *      approved-and-listed (`claim.service.ts` → `findOpportunity`). A plain submitter's entry is
 *      `pending`, so every fixture here is published by a reviewer first — which is also the real
 *      shape of the problem: a claim is how a publisher takes over an entry the public can already
 *      see.
 *   2. A claim for the organization the entry is ALREADY published under is `unchanged`, not
 *      `granted` — there is nothing to transfer. So the entry is submitted under a third namespace
 *      and names the claiming organization among its OPERATING organizations, which is exactly the
 *      aggregator-then-operator sequence the feature exists for.
 */
test.describe("M3-2 claims", () => {
  test.beforeEach(async ({ stack, pendingHeadroom }) => {
    skipUnlessActor(stack, "publisher", "submitter", "reviewer");
    // `publishedEntry` below submits as the submitter and has it approved a moment later, so each
    // fixture holds a review-queue slot only briefly — but it does hold one, and an account with no
    // verified membership has a fixed number. See `pendingHeadroom` for why this is done through a
    // reviewer's decision rather than by editing the row.
    await pendingHeadroom("submitter", 2);
  });

  /**
   * Submits an entry under `sourceNamespace`, naming `alsoOperating` as a second operator, and has a
   * reviewer publish it. Returns its id.
   */
  async function publishedEntry(
    api: (actor: ActorName) => Promise<ApiClient>,
    fixture: (
      namespace: string,
      suffix: string,
      over?: Record<string, unknown>,
    ) => Record<string, unknown>,
    sourceNamespace: string,
    suffix: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const submitter = await api("submitter");
    const document = fixture(sourceNamespace, suffix, over);
    const id = document.id as string;
    expect((await submitter.post("/v1/opportunities", document)).status).toBe(201);

    const reviewer = await api("reviewer");
    const approved = await reviewer.post(
      `/v1/review/opportunities/${encodeURIComponent(id)}/approve`,
      {},
    );
    expect(approved.status, "a claim can only be filed against a public entry").toBe(200);
    return id;
  }

  test("a claim on a verified operating organization is granted immediately", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    // Published under a third-party namespace, but naming the publisher's own verified organization
    // as an operator — the aggregator-listed-it, the-operator-claims-it case.
    const aggregator = `${stack.namespaces.publisher}-aggregator`;
    const id = await publishedEntry(
      api,
      opportunityFixture,
      aggregator,
      `claimable-${Date.now()}`,
      {
        operatingOrganizations: [
          { name: aggregator, slug: aggregator },
          { name: stack.namespaces.publisher, slug: stack.namespaces.publisher },
        ],
      },
    );

    const publisher = await api("publisher");
    const claim = await publisher.post<{ outcome: string; organizationSlug: string }>(
      `/v1/opportunities/${encodeURIComponent(id)}/claim`,
      { organizationSlug: stack.namespaces.publisher },
    );
    expect(claim.status).toBe(200);
    expect(claim.body.outcome).toBe("granted");
    expect(claim.body.organizationSlug).toBe(stack.namespaces.publisher);
  });

  test("a claim needing review is queued, and only a reviewer decides it", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    const aggregator = `${stack.namespaces.publisher}-aggregator2`;
    const unverified = `${stack.namespaces.publisher}-pending`;
    const id = await publishedEntry(api, opportunityFixture, aggregator, `queued-${Date.now()}`, {
      operatingOrganizations: [
        { name: aggregator, slug: aggregator },
        { name: unverified, slug: unverified },
      ],
    });

    // The claimant must be a member of the organization it claims for; that organization is NOT
    // verified, which is what makes the claim reviewable rather than grantable.
    const publisherAccountId = stack.actors.publisher?.accountId;
    if (!publisherAccountId) throw new Error("the publisher's account id was not provisioned");
    const reviewer = await api("reviewer");
    expect(
      (
        await reviewer.post(`/v1/review/organizations/${unverified}/members`, {
          accountId: publisherAccountId,
          role: "publisher",
        })
      ).status,
    ).toBe(200);

    const publisher = await api("publisher");
    const claim = await publisher.post<{ outcome: string; claimId: number | null }>(
      `/v1/opportunities/${encodeURIComponent(id)}/claim`,
      { organizationSlug: unverified },
    );
    expect(claim.status, "a claim that needs review answers 202").toBe(202);
    expect(claim.body.outcome).toBe("queued");
    const claimId = claim.body.claimId;
    expect(claimId).not.toBeNull();

    // A publisher cannot decide its own claim; if it could, the queue would be decoration.
    const selfApprove = await publisher.post<{ error: string }>(
      `/v1/review/claims/${claimId}/approve`,
      { verifyOrganization: true },
    );
    expect(selfApprove.status).toBe(403);

    const approved = await reviewer.post<{ outcome: string }>(
      `/v1/review/claims/${claimId}/approve`,
      { verifyOrganization: true },
    );
    expect(approved.status).toBe(200);

    const verified = await db.query<{ verified: boolean }>(
      "SELECT verified FROM organizations WHERE slug = $1",
      [unverified],
    );
    expect(
      verified.rows[0]?.verified,
      "approving with verification verifies the organization",
    ).toBe(true);
  });

  test("a sponsoring-only organization can never be granted ownership", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const aggregator = `${stack.namespaces.publisher}-aggregator3`;
    const sponsorOnly = `${stack.namespaces.publisher}-sponsor`;
    const id = await publishedEntry(
      api,
      opportunityFixture,
      aggregator,
      `sponsored-${Date.now()}`,
      {
        operatingOrganizations: [{ name: aggregator, slug: aggregator }],
        sponsoringOrganizations: [{ name: sponsorOnly, slug: sponsorOnly }],
      },
    );

    const reviewer = await api("reviewer");
    const publisherAccountId = stack.actors.publisher?.accountId;
    if (!publisherAccountId) throw new Error("the publisher's account id was not provisioned");
    await reviewer.post(`/v1/review/organizations/${sponsorOnly}/members`, {
      accountId: publisherAccountId,
      role: "publisher",
    });
    await reviewer.post(`/v1/review/organizations/${sponsorOnly}/verify`, {});

    const claim = await (await api("publisher")).post<{ outcome: string }>(
      `/v1/opportunities/${encodeURIComponent(id)}/claim`,
      { organizationSlug: sponsorOnly },
    );
    // Verified, a member, and named on the entry — but as a SPONSOR. Sponsorship is money, not
    // operation, and treating the two alike would let a funder seize a programme it merely funds.
    expect(claim.status).toBe(202);
    expect(claim.body.outcome).toBe("queued");
  });

  test("a would-be-granted claim made with a key lacking `publish` is refused, never quietly queued", async ({
    stack,
    api,
    keyClient,
    opportunityFixture,
  }) => {
    const aggregator = `${stack.namespaces.publisher}-aggregator4`;
    const id = await publishedEntry(api, opportunityFixture, aggregator, `keyclaim-${Date.now()}`, {
      operatingOrganizations: [
        { name: aggregator, slug: aggregator },
        { name: stack.namespaces.publisher, slug: stack.namespaces.publisher },
      ],
    });

    const writeOnly = await keyClient("publisher", ["read", "write"]);
    const claim = await writeOnly.client.post<{ error: string; message: string }>(
      `/v1/opportunities/${encodeURIComponent(id)}/claim`,
      { organizationSlug: stack.namespaces.publisher },
    );
    // Refused with the scope named. Queueing it instead would silently downgrade an authorization
    // failure into a review task — and the reviewer would be approving something the credential was
    // never allowed to ask for.
    expect(claim.status).toBe(403);
    expect(claim.body.error).toBe("missing_scope");
    expect(claim.body.message).toContain("publish");
  });
});
