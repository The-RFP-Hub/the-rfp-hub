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
import { expect, skipUnlessActor, test } from "../src/fixtures.js";

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
