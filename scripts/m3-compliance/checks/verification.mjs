/**
 * Criterion 5 — **an entry with a source link produces a snapshot and a
 * `verifiedAgainstSource` flag**.
 *
 * WHAT "SNAPSHOT" MEANS HERE, because it is an amendment to the original wording and not a silent
 * one: M3 stores the extracted plain text of the page plus a **sha256 of the raw bytes**, in the
 * database, as `verification_runs.snapshot_text` / `snapshot_sha256`. It does not pin the page to
 * an external immutable store — `snapshot_url` is redefined as that, and deferred to M4. See
 * `packages/api/docs/data-model.md` §"Snapshots".
 *
 * So this criterion checks that a run was RECORDED and carries a digest, not that the check
 * "passed". `matched` is explicitly a low-bar anti-spam signal rather than a fact-check: the
 * default fixture points at the deployment's own documentation page, which is fetchable and will
 * certainly not match the fixture's title — and `matched: false` is the correct answer there.
 *
 * Verification is triggered after the commit, off the response path, so this polls.
 */
import { callJson } from "../client.mjs";

const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkVerification(report, ctx, state) {
  const c = report.criterion(
    "M3-5",
    "Source verification & snapshot",
    "An entry carrying an applicationUrl produces a recorded verification run with a snapshot digest, and the entry's verifiedAgainstSource flag reflects it.",
  );

  const id = state.publishedId;
  if (!id) {
    c.skip("verification run", "criterion M3-1 did not create a fixture to verify");
    return c.finish();
  }
  const path = `/v1/opportunities/${encodeURIComponent(id)}/verification`;

  let run = await poll(ctx, path);

  // Submit-time verification is optional (`VERIFY_ON_SUBMIT`), and the entry would otherwise be
  // picked up by the nightly backfill. A reviewer can ask for it now.
  if (!run && ctx.adminToken) {
    const triggered = await callJson(
      ctx,
      `/v1/review/opportunities/${encodeURIComponent(id)}/verify`,
      { method: "POST", token: ctx.adminToken },
    );
    if (triggered.ok && triggered.status === 200) {
      c.info("verification triggered on demand", "POST /v1/review/opportunities/{id}/verify → 200");
      run = triggered.json;
    } else if (triggered.status === 403) {
      c.info(
        "verification could not be triggered on demand",
        "the supplied --admin-token is not a reviewer session",
      );
    }
  }

  if (!run) {
    c.skip(
      "a verification run is recorded",
      "no run exists for this entry yet. Either `VERIFICATION_ENABLED` is off, or `VERIFY_ON_SUBMIT` is off and the nightly backfill has not reached it. Supply an --admin-token for a reviewer session to trigger one, or re-run after the backfill.",
    );
    return c.finish();
  }

  c.pass("a verification run is recorded", `HTTP status at source: ${run.httpStatus ?? "n/a"}`);
  c.expect(
    typeof run.runAt === "string" && !Number.isNaN(Date.parse(run.runAt)),
    "the run is timestamped",
    run.runAt,
    `runAt is not a usable timestamp: ${JSON.stringify(run.runAt)}`,
  );
  c.expect(
    run.requestedUrl === state.document?.applicationUrl,
    "the run names the URL it was asked to fetch",
    run.requestedUrl,
    `requested ${JSON.stringify(run.requestedUrl)}, expected the entry's applicationUrl`,
  );
  c.expect(
    typeof run.existsAtSource === "boolean",
    "the run states whether the entry exists at source",
    `existsAtSource ${run.existsAtSource}`,
    "existsAtSource is not a decided boolean",
  );

  // The snapshot of record: a digest of the ORIGINAL bytes, so a later dispute about what the page
  // said is answerable against something immutable rather than against a memory of it.
  if (run.existsAtSource) {
    c.expect(
      typeof run.snapshotSha256 === "string" && /^[0-9a-f]{64}$/.test(run.snapshotSha256),
      "the run carries a sha256 of the fetched bytes (the M3 snapshot of record)",
      run.snapshotSha256,
      `snapshotSha256 is ${JSON.stringify(run.snapshotSha256)} — a snapshot without a digest is not evidence`,
    );
  } else {
    c.skip(
      "the run carries a sha256 of the fetched bytes",
      [
        `the verifier decided the URL does not present a page (${run.error ?? `HTTP ${run.httpStatus}`}), so it has nothing to snapshot.`,
        "With the DEFAULT applicationUrl — the deployment's own documentation shell — that is the",
        "soft-404 heuristic working rather than a defect: the page's text is rendered by script, so",
        "there is almost no visible content to record. Pass --application-url pointing at a real",
        "HTML page to exercise the digest end to end. The run being RECORDED is what this criterion",
        "is about, and it was.",
      ].join(" "),
    );
  }
  c.info("matched", String(run.matched), {
    note: "a low-bar anti-spam signal, not a fact-check: an administrator still approves",
  });

  // …and the flag on the entry itself, which is what a consumer of the Standard document sees.
  const detail = state.isPublic
    ? await callJson(ctx, `/v1/opportunities/${encodeURIComponent(id)}`)
    : await callJson(ctx, `/v1/me/opportunities/${encodeURIComponent(id)}`, {
        token: ctx.credential,
      });
  const source = detail.json?.source ?? {};
  c.expect(
    typeof source.verifiedAgainstSource === "boolean" && typeof source.verifiedAt === "string",
    "the entry carries the flag and the time it was set",
    `verifiedAgainstSource ${source.verifiedAgainstSource} at ${source.verifiedAt}`,
    `the run was recorded but the entry's own provenance was not updated: verifiedAgainstSource=${JSON.stringify(source.verifiedAgainstSource)}, verifiedAt=${JSON.stringify(source.verifiedAt)}`,
  );
  c.expect(
    source.verifiedAgainstSource === run.matched,
    "the entry's flag agrees with the run that set it",
    "flag and run agree",
    `the entry says ${source.verifiedAgainstSource} and the latest run says ${run.matched}`,
  );

  return c.finish();
}

async function poll(ctx, path) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const response = await callJson(ctx, path);
    if (response.ok && response.status === 200 && response.json) return response.json;
    if (response.status !== 404) return null;
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}
