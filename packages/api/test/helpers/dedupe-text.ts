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
 *
 * ONE CLUSTER PER SUITE, and the assignments below are the whole of the rule. The integration files
 * run in PARALLEL against one database, and detection keeps only the top `DEDUPE_MAX_MATCHES`
 * neighbours above the threshold. Two suites writing near-copies of the SAME body therefore do not
 * merely add noise to each other — they compete for those slots, and the loser is whichever suite
 * happened to assert on the pair that fell out. It is the same isolation the namespaces give, for
 * the same reason, and it fails the same way when it is skipped: intermittently, in the other
 * suite, for reasons that have nothing to do with the change under test.
 *
 *   `ALPHA_BODY` / `UNRELATED_BODY` — `duplicates.test.ts`, and `dedupe-prune-scope.test.ts`,
 *      which shares them safely because it boots a DIFFERENT provider and so a different vector
 *      space, where nothing this file writes is a neighbour at all.
 *   `COMPOST_BODY` / `ARCHIVE_BODY` — `dedupe-write-scope.test.ts`.
 *   `LEDGER_BODY` — `notifications.test.ts`.
 *
 * A suite may also keep its bodies to itself rather than take a cluster here, which is what
 * `dedupe-overlap.test.ts` does — it needs bodies shaped for one arm of the rule, and a shared
 * constant that another suite could retune is the opposite of what that test wants. Same rule,
 * declared locally.
 *
 * `reword` is shared by all of them: it is a pure function of whatever it is given.
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

/** ~140 words, `dedupe-write-scope.test.ts`'s pending-side cluster. */
export const COMPOST_BODY =
  "This programme funds municipal composting cooperatives that divert household food waste from " +
  "landfill and return finished compost to community market gardens. Applicants describe their " +
  "collection route, their windrow turning schedule and the contamination rate they currently " +
  "measure at intake, and are assessed by a panel of soil scientists and waste-management " +
  "officers. Payments are released against tonnage diverted and against a published soil carbon " +
  "measurement taken at the receiving gardens twelve months later. We prioritise cooperatives " +
  "serving neighbourhoods with no kerbside organics collection at all, and we expect every " +
  "participant to publish its contamination and tonnage figures openly each quarter. " +
  "Cooperatives already funded by a municipal waste levy for the same routes are asked to say " +
  "so. Decisions are made twice a year, and successful cooperatives join a shared procurement " +
  "arrangement for turning equipment and compostable liners.";

/** ~140 words, `dedupe-write-scope.test.ts`'s public-side cluster. Unrelated to `COMPOST_BODY`. */
export const ARCHIVE_BODY =
  "This fund pays for the digitisation of endangered paper archives held by regional historical " +
  "societies, with an emphasis on parish registers, shipping manifests and mill payroll ledgers. " +
  "Custodians submit a condition survey of the holdings, a proposed scanning resolution and a " +
  "plan for storing the resulting masters in at least two geographically separate repositories. " +
  "Conservation work needed before a volume can safely be opened flat is fundable, and so is the " +
  "cataloguing labour that makes a scan findable rather than merely stored. We do not fund " +
  "proprietary viewer software, and every catalogue record produced must be released under an " +
  "open licence. Holdings already digitised by a national library programme are out of scope. " +
  "Awards are settled once the masters have been deposited and verified against their checksums, " +
  "and custodians report on reading-room and online consultation figures annually.";

/** ~140 words, `notifications.test.ts`'s cluster. */
export const LEDGER_BODY =
  "This initiative underwrites regional seed banks that maintain landrace cereal and pulse " +
  "collections outside the national gene bank system. Curators set out their regeneration cycle, " +
  "their germination testing interval and the accession records they keep for each variety, and " +
  "are assessed by agronomists alongside growers who have used the collection in the field. " +
  "Instalments follow verified regeneration of a named subset and the deposit of duplicate " +
  "accessions with a partner bank in another watershed. We favour collections that lend freely " +
  "to smallholders over those held only for research, and every accession record must remain " +
  "publicly searchable. Collections already duplicated under an international treaty arrangement " +
  "should say so at the outset. Awards are decided each autumn, and curators join a seasonal " +
  "exchange where germination results and varietal notes circulate between participating banks.";

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
