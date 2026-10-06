import { DESKTOP_UA, expect, freshIdentity, skipUnlessActor, test } from "../src/fixtures.js";
import { ApiClient } from "../src/http.js";
/**
 * Open claims and member invites.
 *
 * Any signed-in account may file a claim for an organization that exists; a reviewer's approval is
 * the gate, and approving adds the claimant as a publisher. Org owners and admins may invite
 * colleagues by email; an invite applies at the invitee's next verified sign-in.
 */
import { addressFor } from "../src/identity/sessions.js";
import type { ActorName } from "../src/state.js";

test.describe.configure({ mode: "serial" });

interface Me {
  accountId: number;
  memberships: Array<{ slug: string; role: string; verified: boolean }>;
}

function clientFor(stack: { urls: { api: string } }, token: string): ApiClient {
  return new ApiClient({ baseUrl: stack.urls.api, token, userAgent: DESKTOP_UA });
}

test.describe("open claims", () => {
  test.beforeEach(async ({ stack, pendingHeadroom }) => {
    skipUnlessActor(stack, "submitter", "reviewer");
    await pendingHeadroom("submitter", 2);
  });

  async function publishedEntry(
    api: (actor: ActorName) => Promise<ApiClient>,
    fixture: (
      namespace: string,
      suffix: string,
      over?: Record<string, unknown>,
    ) => Record<string, unknown>,
    namespace: string,
    suffix: string,
    operating: string[],
  ): Promise<{ id: string; title: string }> {
    // Published under a namespace of its own, so a claim for an operating organization is a real
    // change rather than "unchanged".
    const aggregator = `${namespace}-agg`;
    const document = fixture(aggregator, suffix, {
      title: `Open claim fixture ${suffix}`,
      operatingOrganizations: [aggregator, ...operating].map((slug) => ({ name: slug, slug })),
    });
    const submitter = await api("submitter");
    expect((await submitter.post("/v1/opportunities", document)).status).toBe(201);
    const id = document.id as string;
    const reviewer = await api("reviewer");
    expect(
      (await reviewer.post(`/v1/review/opportunities/${encodeURIComponent(id)}/approve`, {}))
        .status,
    ).toBe(200);
    return { id, title: document.title as string };
  }

  test("a stranger files a claim from the listing and approval makes them a publisher", async ({
    stack,
    api,
    contextAs,
    opportunityFixture,
  }) => {
    const stamp = Date.now();
    const slug = `${stack.namespaces.publisher}-open`;
    const { id } = await publishedEntry(api, opportunityFixture, slug, `open-claim-${stamp}`, [
      slug,
    ]);

    const claimant = await freshIdentity(stack, `claimant-${stamp}`);
    const claimantApi = clientFor(stack, claimant.token);
    const before = await claimantApi.get<Me>("/v1/me");
    expect(before.body.memberships, "the claimant is a stranger to the organization").toEqual([]);

    const claimantContext = await contextAs({ email: claimant.email });
    const page = await claimantContext.newPage();
    await page.goto(`${stack.urls.frontend}/opportunities/${encodeURIComponent(id)}`);
    await page.locator("summary", { hasText: /claim/i }).click();
    await page.getByLabel("Organization", { exact: true }).selectOption(slug);
    await page.getByLabel(/note/i).fill(`open claim ${stamp}`);
    await page.getByRole("button", { name: "File the claim" }).click();
    await expect(page.getByText(/queued/i)).toBeVisible();

    const reviewerContext = await contextAs("reviewer");
    const review = await reviewerContext.newPage();
    await review.goto(`${stack.urls.frontend}/review?tab=claims`);
    const row = review.locator("tr").filter({ hasText: id });
    await expect(row).toHaveCount(1);
    await expect(
      row.getByText(/Not a member of .* approving adds them as a publisher/),
    ).toBeVisible();
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(review.locator("tr").filter({ hasText: id })).toHaveCount(0);

    const after = await claimantApi.get<Me>("/v1/me");
    expect(after.body.memberships.map((m) => [m.slug, m.role])).toEqual([[slug, "publisher"]]);
    await claimantContext.close();
    await reviewerContext.close();
  });

  test("a claim for an organization that does not exist is a 404", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const stamp = Date.now();
    const slug = `${stack.namespaces.publisher}-known`;
    const { id } = await publishedEntry(api, opportunityFixture, slug, `unknown-${stamp}`, [slug]);
    const stranger = clientFor(stack, (await freshIdentity(stack, `unknown-${stamp}`)).token);
    const response = await stranger.post(`/v1/opportunities/${encodeURIComponent(id)}/claim`, {
      organizationSlug: `no-such-org-${stamp}`,
    });
    expect(response.status).toBe(404);
  });

  test("an account holds at most ten pending claims", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const stamp = Date.now();
    const base = `${stack.namespaces.publisher}-cap${stamp}`;
    const slugs = Array.from({ length: 11 }, (_, index) => `${base}-${index}`);
    const { id } = await publishedEntry(
      api,
      opportunityFixture,
      slugs[0] as string,
      `cap-${stamp}`,
      slugs,
    );

    const claimant = clientFor(stack, (await freshIdentity(stack, `cap-${stamp}`)).token);
    const path = `/v1/opportunities/${encodeURIComponent(id)}/claim`;
    for (const slug of slugs.slice(0, 10)) {
      const filed = await claimant.post(path, { organizationSlug: slug });
      expect(filed.status, `${slug} → ${filed.text.slice(0, 160)}`).toBe(202);
    }
    const over = await claimant.post<{ error: string }>(path, { organizationSlug: slugs[10] });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("too_many_pending_claims");
  });
});

test.describe("member invites", () => {
  test.beforeEach(({ stack }) => {
    skipUnlessActor(stack, "publisher", "reviewer");
  });

  async function organizationWith(
    stack: Parameters<typeof clientFor>[0] & { namespaces: { publisher: string } },
    api: (actor: ActorName) => Promise<ApiClient>,
    fixture: (namespace: string, suffix: string) => Record<string, unknown>,
    slug: string,
    members: Array<{ label: string; role: "owner" | "admin" | "publisher" }>,
  ) {
    const publisher = await api("publisher");
    expect((await publisher.post("/v1/opportunities", fixture(slug, `inv-${slug}`))).status).toBe(
      201,
    );
    const reviewer = await api("reviewer");
    const granted: Record<string, { email: string; token: string; accountId: number }> = {};
    for (const member of members) {
      const identity = await freshIdentity(stack as never, member.label);
      const me = await clientFor(stack, identity.token).get<Me>("/v1/me");
      expect(
        (
          await reviewer.post(`/v1/review/organizations/${slug}/members`, {
            accountId: me.body.accountId,
            role: member.role,
          })
        ).status,
      ).toBe(200);
      granted[member.label] = { ...identity, accountId: me.body.accountId };
    }
    return granted;
  }

  test("an owner invites by email in the browser, the invite applies at sign-in, and can be revoked", async ({
    stack,
    api,
    contextAs,
    opportunityFixture,
  }) => {
    const stamp = Date.now();
    const slug = `${stack.namespaces.publisher}-inv${stamp}`;
    const people = await organizationWith(stack, api, opportunityFixture, slug, [
      { label: `owner-${stamp}`, role: "owner" },
    ]);
    const owner = people[`owner-${stamp}`] as { email: string; token: string };
    const inviteeEmail = addressFor(stack.runId, `invitee-${stamp}`);
    const revokedEmail = addressFor(stack.runId, `revoked-${stamp}`);

    const context = await contextAs({ email: owner.email });
    const page = await context.newPage();
    await page.goto(`${stack.urls.frontend}/organizations/${slug}`);
    for (const [email, role] of [
      [inviteeEmail, "admin"],
      [revokedEmail, "publisher"],
    ] as const) {
      await page.getByLabel("Email address", { exact: true }).fill(email);
      await page.getByLabel("Role", { exact: true }).selectOption(role);
      await page.getByRole("button", { name: "Send the invitation" }).click();
      await expect(page.getByText(`Invitation saved for ${email}.`)).toBeVisible();
    }

    const table = page.getByRole("table", { name: "Pending membership invites" });
    await expect(table.getByRole("row", { name: inviteeEmail })).toBeVisible();
    await table
      .getByRole("row", { name: revokedEmail })
      .getByRole("button", { name: "Revoke" })
      .click();
    await expect(
      page.getByText(`The pending invitation for ${revokedEmail} was revoked.`),
    ).toBeVisible();

    const invitee = await freshIdentity(stack, `invitee-${stamp}`);
    const joined = await clientFor(stack, invitee.token).get<Me>("/v1/me");
    expect(joined.body.memberships.map((m) => [m.slug, m.role])).toEqual([[slug, "admin"]]);

    const outsider = await freshIdentity(stack, `revoked-${stamp}`);
    const none = await clientFor(stack, outsider.token).get<Me>("/v1/me");
    expect(none.body.memberships, "a revoked invite grants nothing").toEqual([]);
    await context.close();
  });

  test("the API holds the line: existing members, owner invites by admins, and non-managers", async ({
    stack,
    api,
    opportunityFixture,
  }) => {
    const stamp = Date.now();
    const slug = `${stack.namespaces.publisher}-rules${stamp}`;
    const people = await organizationWith(stack, api, opportunityFixture, slug, [
      { label: `rowner-${stamp}`, role: "owner" },
      { label: `radmin-${stamp}`, role: "admin" },
      { label: `rpub-${stamp}`, role: "publisher" },
    ]);
    const path = `/v1/organizations/${slug}/invites`;
    const owner = clientFor(stack, (people[`rowner-${stamp}`] as { token: string }).token);
    const admin = clientFor(stack, (people[`radmin-${stamp}`] as { token: string }).token);
    const member = clientFor(stack, (people[`rpub-${stamp}`] as { token: string }).token);
    const ownerEmail = (people[`rowner-${stamp}`] as { email: string }).email;

    const existing = await admin.post<{ error: string }>(path, {
      email: ownerEmail,
      role: "publisher",
    });
    expect(existing.status, "an admin cannot demote an owner by inviting them").toBe(409);
    expect(existing.body.error).toBe("already_a_member");

    const ownerInvite = await admin.post<{ error: string }>(path, {
      email: addressFor(stack.runId, `x-${stamp}`),
      role: "owner",
    });
    expect(ownerInvite.status).toBe(403);
    expect(ownerInvite.body.error).toBe("owner_role_requires_owner");

    const byPublisher = await member.post<{ error: string }>(path, {
      email: addressFor(stack.runId, `y-${stamp}`),
      role: "publisher",
    });
    expect(byPublisher.status).toBe(403);
    expect(byPublisher.body.error).toBe("not_an_org_manager");
    expect((await member.get(path)).status).toBe(403);

    const ok = await owner.post(path, {
      email: addressFor(stack.runId, `z-${stamp}`),
      role: "owner",
    });
    expect(ok.status, "an owner may invite another owner").toBe(200);
  });
});
