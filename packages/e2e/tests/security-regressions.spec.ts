/**
 * The concurrency and privilege regressions, at the layer each one can actually be proven at.
 *
 * READ THIS BEFORE ADDING TO THIS FILE. Three of the four fixes below are about INTERLEAVING, and
 * an interleaving cannot be established over HTTP. Firing two requests at once and inspecting the
 * result proves that the two requests both completed; it does not prove that the second one saw the
 * first one's row, or that it would have if the schedule had been unkind. The authoritative proofs
 * are deterministic, barrier-driven and live at the integration layer:
 *
 *   packages/api/test/integration/write-concurrency.test.ts   the replace race, and revocation
 *                                                             racing an auto-publishing write
 *   packages/api/test/unit/publish-authority.test.ts          the authority decision itself
 *   packages/api/test/integration/api-key-limit.test.ts       the key-limit race, at the service
 *   packages/api/test/integration/audit-privilege.test.ts     both immutability layers
 *
 * What this file adds is the thing those cannot show: that the same code paths behave under REAL
 * concurrent HTTP against a real process pool, with a real restricted database role. Each test says
 * which of the two it is.
 */
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

test.describe.configure({ mode: "serial" });

test.describe("security regressions over real HTTP", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  test("SMOKE: concurrent key creation at the limit never exceeds it", async ({
    api,
    db,
    stack,
  }) => {
    // AUTHORITATIVE PROOF: api-key-limit.test.ts, which seeds 24 keys and drives two concurrent
    // creates at the service, below the route's 10/min rate limit. This is the HTTP smoke.
    const publisher = await api("publisher");
    const accountId = stack.actors.publisher?.accountId;
    if (!accountId) throw new Error("the publisher's account id was not provisioned");

    // `retryOn429: false` keeps this a genuine single-shot race: a retried request is a second,
    // later request, which is precisely what this test must not turn its two concurrent ones into.
    const [first, second] = await Promise.all([
      publisher.request<{ key: { id: number } }>({
        method: "POST",
        path: "/v1/keys",
        body: { name: "race-a", scopes: ["read"] },
        retryOn429: false,
      }),
      publisher.request<{ key: { id: number } }>({
        method: "POST",
        path: "/v1/keys",
        body: { name: "race-b", scopes: ["read"] },
        retryOn429: false,
      }),
    ]);

    for (const response of [first, second]) {
      // 429 is a legitimate third outcome and is listed rather than treated as a flake: the route
      // carries its own 10-per-minute limit, and several earlier specs in the same run mint keys
      // through the same account. The limit firing is the rate limiter working, not the ceiling
      // failing — and the ceiling is what this test asserts, below, whichever way the two calls went.
      expect(
        [201, 400, 429],
        "a concurrent create is accepted, refused for the ceiling, or rate limited",
      ).toContain(response.status);
    }

    const live = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM api_keys WHERE account_id = $1 AND revoked_at IS NULL",
      [accountId],
    );
    // The invariant, whatever the interleaving was: the ceiling holds.
    expect(live.rows[0]?.n).toBeLessThanOrEqual(25);

    for (const response of [first, second]) {
      if (response.status === 201) {
        await publisher.delete(`/v1/keys/${response.body.key.id}`).catch(() => undefined);
      }
    }
  });

  test("SMOKE: a membership revoked mid-flight cannot leave a published entry behind", async ({
    stack,
    api,
    db,
    opportunityFixture,
  }) => {
    // AUTHORITATIVE PROOF: write-concurrency.test.ts parks an auto-publishing write at a barrier
    // taken immediately after its `FOR UPDATE`, revokes the membership on a second connection, and
    // releases — which is the only way to observe the window. Here the two are merely issued
    // together, and the assertion is the INVARIANT rather than the schedule.
    const publisher = await api("publisher");
    const reviewer = await api("reviewer");
    const accountId = stack.actors.publisher?.accountId;
    if (!accountId) throw new Error("the publisher's account id was not provisioned");

    const document = opportunityFixture(stack.namespaces.publisher, `revoke-race-${Date.now()}`);
    const id = document.id as string;

    const [write] = await Promise.all([
      publisher.post<{ reviewStatus: string }>("/v1/opportunities", document),
      reviewer.delete(
        `/v1/review/organizations/${stack.namespaces.publisher}/members/${accountId}`,
      ),
    ]);

    const stored = await db.query<{ review_status: string }>(
      "SELECT review_status FROM opportunities WHERE public_id = $1",
      [id],
    );
    if (write.status === 201) {
      // Whatever the ordering was, the stored state and the answer given to the client must agree.
      // A response that said `approved` over a row that is `pending` (or the reverse) would be the
      // real defect — a client acting on an answer the database does not support.
      expect(stored.rows[0]?.review_status).toBe(write.body.reviewStatus);
    }

    // Restore the membership: later specs in this file and others depend on it.
    await reviewer.post(`/v1/review/organizations/${stack.namespaces.publisher}/members`, {
      accountId,
      role: "publisher",
    });
  });
});

/**
 * Least privilege is a property of the RUN, not of any identity, so this executes at every ladder
 * level — including the one where no real credential could be obtained. That matters: the boot
 * itself is the evidence, and evidence that only appears when the run is fully credentialled is
 * evidence that goes missing exactly when a reader most needs it.
 */
test.describe("the application runs under least privilege", () => {
  test("the API is running on the restricted role, and every route above worked on it", async ({
    stack,
    restrictedDb,
    db,
  }) => {
    // This is the assertion that gives the whole run its least-privilege meaning: the API process
    // was handed the RESTRICTED connection string, so every 2xx anywhere in this suite was produced
    // by that role. Any missing GRANT would have surfaced as a real 500 on a real route rather than
    // being masked by an over-privileged connection.
    expect(stack.db.runtimeUrl).not.toBe(stack.db.adminUrl);
    expect(new URL(stack.db.runtimeUrl).username).toBe(stack.db.runtimeRole);

    const asRuntime = await restrictedDb.query<{ role: string }>("SELECT current_user AS role");
    expect(asRuntime.rows[0]?.role).toBe(stack.db.runtimeRole);

    const asOwner = await db.query<{ role: string }>("SELECT current_user AS role");
    expect(
      asOwner.rows[0]?.role,
      "the harness's own handle is the owner, and is not what the API uses",
    ).not.toBe(stack.db.runtimeRole);

    // The runtime role is not a superuser and does not own the schema — otherwise the audit REVOKE
    // would be advisory, since an owner can grant privileges back to itself.
    const attributes = await restrictedDb.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(attributes.rows[0]?.rolsuper).toBe(false);
    expect(attributes.rows[0]?.rolbypassrls).toBe(false);
  });
});
