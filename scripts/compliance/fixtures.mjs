/**
 * The documents this checker writes, and the one rule that keeps them findable afterwards.
 *
 * Every id this run creates is `<namespace>:m3check-<run>-<name>`. The `m3check-` prefix is what
 * makes a leftover fixture identifiable months later as a compliance artifact rather than a real
 * listing somebody has to investigate, and `<run>` is a UTC timestamp so two runs never collide on
 * a `public_id` and report a `409` as a criterion failure.
 *
 * The documents are Standard-valid and deliberately dull. This tool checks the API's behaviour, not
 * the schema's expressiveness — a fixture with an interesting funding envelope would only add ways
 * for a criterion to fail for a reason that is not the criterion.
 */

/** `20260814T2210` — sortable, and short enough to read in a list of ids. */
export function runStamp(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .slice(0, 13);
}

export const FIXTURE_MARKER = "m3check";

export function fixtureId(namespace, run, name) {
  return `${namespace}:${FIXTURE_MARKER}-${run}-${name}`;
}

/**
 * A Standard-valid opportunity.
 *
 * `applicationUrl` points at the target API's own service-info document by default: the
 * verification criterion needs a URL the deployment can actually reach, and a link to the
 * deployment itself is the one URL guaranteed to exist, to be public, and to belong to nobody
 * else. It will not "match" the entry's title, which is exactly what the criterion asserts about —
 * that a run is RECORDED with a snapshot digest, not that a check passed.
 */
export function fixtureDocument({ id, namespace, title, applicationUrl, deadlines, summary }) {
  return {
    specVersion: "1.0.0",
    id,
    fundingType: "grant",
    title,
    summary: summary ?? "A compliance fixture created by scripts/check-m3.mjs.",
    description:
      "Created by the RFP Hub M3 compliance checker to verify the write, provenance and analytics surfaces of a deployment. It is not a real funding opportunity and should be rejected or unlisted after the run.",
    status: "open",
    operatingOrganizations: [{ name: namespace, slug: namespace }],
    ecosystems: ["Ethereum"],
    categories: ["tooling"],
    source: {},
    ...(applicationUrl ? { applicationUrl } : {}),
    ...(deadlines ? { deadlines } : {}),
    fundingDetails: { fundingType: "grant" },
  };
}

/**
 * The near-duplicate of a fixture: the same programme as a second publisher would have written it.
 *
 * Reworded rather than copied — a byte-identical repeat is the idempotency path, which is a
 * different behaviour and would prove nothing about similarity detection.
 */
export function paraphraseOf(base, id) {
  return {
    ...base,
    id,
    // A REALISTIC near-duplicate: the same programme, with site furniture on the title and a few
    // words swapped for their near-synonyms — which is what a second publisher's transcription of
    // the same round actually looks like.
    //
    // It deliberately keeps most of the wording. A wholesale rewrite would be a different
    // programme, and a byte-identical copy would take the idempotency path instead (an identical
    // repeat POST returns the original, which is a different behaviour and proves nothing about
    // similarity). Note that the embedding text prefers `summary` over `description`, so the
    // summary is the field that has to stay close.
    title: `${base.title} — programme details`,
    summary: base.summary
      .replace("created by", "set up by")
      .replace("A compliance", "The compliance"),
    description: `${base.description} Reworded for the duplicate-detection criterion.`,
  };
}
