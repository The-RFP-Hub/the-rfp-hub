/**
 * Bodies for the duplicate-detection suites, and the one rewrite that turns a record into its own
 * near-duplicate.
 *
 * These are HAND-WRITTEN rather than lifted from the corpus, for the same reason
 * `opportunity-fixture.ts` is: the suites vary one thing at a time, and a fixture that changes when
 * somebody curates a corpus record is a fixture that fails for reasons the test is not about.
 *
 * They are long on purpose. The deterministic provider is a bag of words, so two three-sentence
 * records are separated mostly by noise; a realistic body is what makes "the same programme,
 * reworded" and "a different programme" different in the way the threshold assumes.
 */

/** ~140 words about one programme. */
export const ALPHA_BODY =
  "The Superchain Builders Fund supports independent teams shipping public goods infrastructure " +
  "across the rollup ecosystem. Applicants propose a scope of work covering protocol tooling, " +
  "developer libraries, indexing services or client diversity, and are evaluated by a rotating " +
  "committee of contributors drawn from the participating chains. Awards are paid in two " +
  "tranches against agreed milestones, with the second tranche released after a public retro " +
  "write-up. We prioritise work that unblocks other builders rather than end-user applications, " +
  "and we expect every deliverable to be released under a permissive open source licence. Teams " +
  "already receiving retroactive rewards for the same scope are asked to say so in the " +
  "application. Reviews happen on a rolling basis and most decisions land within four weeks of " +
  "submission. Successful applicants join a quarterly cohort call where progress and blockers " +
  "are discussed openly with the committee and with other funded teams.";

/** ~140 words about something else entirely: no shared subject, only shared function words. */
export const UNRELATED_BODY =
  "This bounty programme pays for confirmed vulnerabilities in the settlement contracts of a " +
  "perpetual futures venue. Severity is assessed against an impact-and-likelihood matrix, and " +
  "payouts scale with the value demonstrably at risk rather than with the effort of the report. " +
  "Researchers must supply a runnable proof of concept against a forked mainnet state, a written " +
  "explanation of the root cause, and a suggested remediation. Duplicate reports are paid to the " +
  "first submitter only, judged by the timestamp on the encrypted disclosure. Findings that " +
  "require privileged operator keys, unrealistic gas assumptions or governance capture are out " +
  "of scope, as are denial-of-service issues with no economic consequence. Reports are " +
  "acknowledged within one business day and triaged within five. Payment is settled in stablecoin " +
  "once a fix is deployed, and disclosure is coordinated with the security council.";

/**
 * Rewrite a body the way a second publisher would: shorter, with the domain's near-synonyms swapped.
 *
 * Deterministic — a fixed stride and a fixed table, no RNG — so a rerun scores identically and a
 * failure means the detector changed rather than the fixture.
 */
export function reword(text: string): string {
  const substitutions: [RegExp, string][] = [
    [/\bsupports?\b/gi, "backs"],
    [/\bteams?\b/gi, "groups"],
    [/\bapplicants?\b/gi, "candidates"],
    [/\bcommittees?\b/gi, "panel"],
    [/\bawards?\b/gi, "payments"],
    [/\bprogramme?\b/gi, "initiative"],
  ];
  let out = text;
  for (const [pattern, replacement] of substitutions) out = out.replace(pattern, replacement);
  return out
    .split(/\s+/)
    .filter((_, index) => index % 6 !== 0)
    .join(" ");
}
