/**
 * Criterion 1 — **a publisher account can be taken end to end**: identity resolves, credentials can
 * be minted, an entry is submitted through the API and then updated through it.
 *
 * This is the criterion the other six lean on: it is what puts a fixture into the deployment for
 * the audit, duplicate, verification and analytics criteria to look at. Its outcome is therefore
 * recorded in `state`, and a criterion whose prerequisite did not happen SKIPS with that as the
 * reason rather than failing for something it never got to test.
 */
import { callJson } from "../client.mjs";
import { fixtureDocument, fixtureId } from "../fixtures.mjs";

export async function checkLifecycle(report, ctx, state) {
  const c = report.criterion(
    "lifecycle",
    "Publisher lifecycle",
    "Identity resolves, a scoped key can be minted, and an entry is created and then replaced through the API.",
  );

  // ── who is this credential ────────────────────────────────────────────────────
  const me = await callJson(ctx, "/v1/me", { token: ctx.credential });
  if (!me.ok || me.status !== 200 || !me.json) {
    c.fail(
      "GET /v1/me resolves the credential",
      me.ok ? `HTTP ${me.status}: ${me.body?.slice(0, 200)}` : me.error,
    );
    return c.finish();
  }
  state.me = me.json;
  c.pass(
    "GET /v1/me resolves the credential",
    `account ${me.json.accountId}, role ${me.json.role}`,
  );
  c.info("credential kind", me.json.credentialKind, {
    scopes: me.json.scopes,
    directCreate: me.json.directCreate,
  });

  const membership = (me.json.memberships ?? []).find((m) => m.slug === ctx.namespace);
  state.verifiedPublisher = Boolean(membership?.verified) || me.json.directCreate === true;
  if (membership) {
    c.expect(
      membership.verified === true,
      `the account is a member of "${ctx.namespace}"`,
      `role ${membership.role}, organisation verified`,
      `role ${membership.role}, but the organisation is NOT verified — submissions into this namespace will land pending, which is the documented behaviour and not a failure of the API`,
    );
  } else if (me.json.directCreate) {
    c.pass(
      `the account may publish into "${ctx.namespace}"`,
      "no membership, but the account holds direct-create",
    );
  } else {
    c.warn(
      `the account is not a verified publisher of "${ctx.namespace}"`,
      "the submission below will land pending. That is correct behaviour, but it is not the publisher lifecycle this criterion is for — supply a credential for a verified member to exercise it.",
    );
  }

  // ── mint a key, if we hold a session ──────────────────────────────────────────
  if (ctx.sessionToken) {
    const minted = await callJson(ctx, "/v1/keys", {
      method: "POST",
      token: ctx.sessionToken,
      body: { name: `compliance ${state.run}`, scopes: ["read", "write", "publish"] },
    });
    if (minted.ok && (minted.status === 200 || minted.status === 201) && minted.json?.token) {
      state.mintedKeyId = minted.json.key?.id ?? null;
      state.mintedKey = minted.json.token;
      c.pass(
        "POST /v1/keys mints a publishing credential",
        `prefix ${minted.json.key?.keyPrefix}, scopes ${(minted.json.key?.scopes ?? []).join(",")}`,
      );
      c.expect(
        String(minted.json.token).startsWith("rfph_"),
        "the secret is returned in the mint response",
        "returned once, at mint, and stored nowhere",
        `the token does not carry the documented \`rfph_\` prefix: ${String(minted.json.token).slice(0, 6)}…`,
      );
      // The key is what the write below uses: the criterion is about a PUBLISHER credential, and a
      // session would prove something weaker (a session is the account itself, not a delegation).
      state.writeToken = minted.json.token;
    } else {
      c.fail(
        "POST /v1/keys mints a publishing credential",
        minted.ok ? `HTTP ${minted.status}: ${minted.body?.slice(0, 200)}` : minted.error,
      );
    }
  } else {
    c.skip(
      "POST /v1/keys mints a publishing credential",
      "no --session-token: key management is session-only by design, so an API-key run cannot exercise it",
    );
  }
  state.writeToken ??= ctx.credential;

  // ── submit ───────────────────────────────────────────────────────────────────
  const id = fixtureId(ctx.namespace, state.run, "published");
  const document = fixtureDocument({
    id,
    namespace: ctx.namespace,
    title: `M3 compliance fixture ${state.run}`,
    // The deployment's own documentation page by default: the one URL guaranteed to exist, to be
    // public, to belong to nobody else, and to be served as HTML — so the verification criterion
    // has something real to fetch without this tool depending on a third-party site staying up.
    // `--application-url` overrides it; see the note in checks/verification.mjs for what that buys.
    applicationUrl: ctx.applicationUrl ?? `${ctx.api}/v1/docs`,
  });
  state.document = document;

  const created = await callJson(ctx, "/v1/opportunities", {
    method: "POST",
    token: state.writeToken,
    body: document,
  });
  if (!created.ok || created.status !== 201 || !created.json) {
    c.fail(
      "POST /v1/opportunities accepts a Standard-valid entry",
      created.ok ? `HTTP ${created.status}: ${created.body?.slice(0, 300)}` : created.error,
    );
    return c.finish();
  }
  state.publishedId = id;
  state.fixtureIds.push(id);
  state.reviewStatus = created.json.reviewStatus;
  c.pass(
    "POST /v1/opportunities accepts a Standard-valid entry",
    `201, reviewStatus ${created.json.reviewStatus}, duplicateCheck ${created.json.duplicateCheck}`,
  );
  c.info("advisory warnings", String((created.json.warnings ?? []).length), {
    warnings: created.json.warnings ?? [],
  });

  // The server owns attribution. A submitter that could set it could impersonate a publisher.
  const source = created.json.opportunity?.source ?? {};
  c.expect(
    source.publisher === ctx.namespace,
    "the server sets `source.publisher` to the resolved namespace",
    `source.publisher = ${source.publisher}`,
    `expected ${ctx.namespace}, got ${JSON.stringify(source.publisher)}`,
  );
  c.expect(
    typeof source.submittedAt === "string" && !Number.isNaN(Date.parse(source.submittedAt)),
    "the server sets `source.submittedAt`",
    source.submittedAt,
    `not a server timestamp: ${JSON.stringify(source.submittedAt)}`,
  );

  // ── is it live ───────────────────────────────────────────────────────────────
  const publicRead = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}`);
  state.isPublic = publicRead.ok && publicRead.status === 200;
  if (created.json.reviewStatus === "approved") {
    c.expect(
      state.isPublic,
      "an approved entry is immediately on the public read surface",
      "GET /v1/opportunities/{id} → 200",
      `GET /v1/opportunities/{id} → ${publicRead.status ?? publicRead.error}`,
    );
  } else {
    c.expect(
      publicRead.status === 404,
      "a pending entry is invisible to the public read surface",
      "GET /v1/opportunities/{id} → 404, as it must be",
      `a pending entry answered ${publicRead.status} — pending entries must not be readable`,
    );
  }

  // ── update ───────────────────────────────────────────────────────────────────
  const updatedTitle = `M3 compliance fixture ${state.run} (updated)`;
  const replaced = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}`, {
    method: "PUT",
    token: state.writeToken,
    body: { ...document, title: updatedTitle },
  });
  c.expect(
    replaced.ok && replaced.status === 200,
    "PUT /v1/opportunities/{id} replaces the entry",
    "200",
    replaced.ok ? `HTTP ${replaced.status}: ${replaced.body?.slice(0, 300)}` : replaced.error,
  );
  state.updated = replaced.ok && replaced.status === 200;

  if (state.updated) {
    const readBack = state.isPublic
      ? await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}`)
      : await callJson(ctx, `/v1/me/opportunities/${encodeURIComponent(id)}`, {
          token: ctx.credential,
        });
    c.expect(
      readBack.json?.title === updatedTitle,
      "the update is what the API now serves",
      `title is "${updatedTitle}"`,
      `read back "${readBack.json?.title}"`,
    );
  }

  // The immutability rule, checked because it is the one an integration hits by accident.
  const renamed = await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}`, {
    method: "PUT",
    token: state.writeToken,
    body: { ...document, id: `${id}-renamed` },
  });
  c.expect(
    renamed.status === 400,
    "PUT refuses to rename an entry",
    "400 — `id` is immutable",
    `expected 400, got ${renamed.status ?? renamed.error}`,
  );

  return c.finish();
}

/** Used by the later criteria to explain a skip in the words of what did not happen. */
export function missingFixture(state) {
  return state.publishedId
    ? null
    : "the lifecycle criterion did not create a fixture, so there is nothing to check this against";
}

export const meta = {
  key: "lifecycle",
  requires: [],
  needs: ["api", "namespace", "credential"],
  writes: true,
  contract: { m3: "M3-1" },
};

export async function run(ctx) {
  await checkLifecycle(ctx.report, ctx, ctx.state);
}
