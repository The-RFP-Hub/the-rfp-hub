/**
 * The handful of addresses this frontend links OUT to, in one module.
 *
 * They were scattered as literals across a footer, a sign-in panel and two prose paragraphs, which
 * is how a project ends up with three different spellings of its own repository URL and one of them
 * 404ing. Collected here, they are also greppable — which matters for a public, source-neutral
 * repository where every outbound address is something a reader may check.
 *
 * IN-APP ROUTES ARE RELATIVE and are constants rather than strings, so a rename is one edit.
 *
 * THE API'S OWN PAGES ARE DERIVED FROM THE CONFIGURED ORIGIN, never hard-coded: a deployment
 * pointed at a different API must link to THAT API's documentation, and a literal here would send
 * every reader of a preview deployment to production's docs.
 */

/** In-app. */
export const HOW_IT_WORKS = "/how-it-works";
export const HOW_IT_WORKS_ROLES = `${HOW_IT_WORKS}#roles`;
export const DIRECTORY = "/";

/**
 * The project's source, and the Standard that lives inside it.
 *
 * A literal, because there is no environment variable for it and inventing one would make the
 * footer of a correctly-built deployment depend on a variable nobody sets. It is the project's own
 * canonical repository — the same address `package.json` names — and a fork that wants its own is
 * editing one line.
 */
export const REPOSITORY = "https://github.com/The-RFP-Hub/the-rfp-hub";

/**
 * The Standard: the schema, its documentation and its changelog, as a human reads them.
 *
 * The machine-readable `$id`s live on the canonical spec domain; this is the README beside them,
 * which is what somebody clicking "The Standard" in a footer is actually after.
 */
export const STANDARD = `${REPOSITORY}/tree/main/packages/standard`;

/** The API's interactive documentation, on whichever API this build talks to. */
export function apiDocsUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/v1/docs`;
}

/** The bulk data exports, on whichever API this build talks to. */
export function exportUrl(apiBaseUrl: string, format: "json" | "csv"): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/v1/export/opportunities.${format}`;
}
