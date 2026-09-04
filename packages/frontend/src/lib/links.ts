/**
 * Every address this frontend links OUT to, in one module — greppable, and a rename is one edit
 * (`test/no-governance-literals.test.ts` keeps it that way). The API's own pages are derived from
 * the CONFIGURED origin: a deployment pointed at another API links to that API's documentation.
 */

/** In-app. */
export const HOW_IT_WORKS = "/how-it-works";
export const HOW_IT_WORKS_ROLES = `${HOW_IT_WORKS}#roles`;
export const DIRECTORY = "/";
export const PUBLISHERS = "/publishers";

/** A literal: the address `package.json` names. A fork that wants its own edits one line. */
export const REPOSITORY = "https://github.com/The-RFP-Hub/the-rfp-hub";

/** The Standard as a human reads it — the README, not the machine-readable `$id`s. */
export const STANDARD = `${REPOSITORY}/tree/main/packages/standard`;

export const GOVERNANCE = `${REPOSITORY}/blob/main/GOVERNANCE.md`;

export const PUBLISHERS_DOC = `${REPOSITORY}/blob/main/PUBLISHERS.md`;

export const REVIEW_CRITERIA = `${REPOSITORY}/blob/main/REVIEW-CRITERIA.md`;

export const RFC_PROCESS = `${REPOSITORY}/blob/main/packages/standard/PROCESS.md#rfc-process`;

/** Client-specific install and private-environment setup for the RFP Hub MCP server. */
export const MCP_GUIDE = `${REPOSITORY}/blob/main/packages/mcp/README.md#submit-from-an-agent`;

/** The API's interactive documentation, on whichever API this build talks to. */
export function apiDocsUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/v1/docs`;
}

/** The bulk data exports, on whichever API this build talks to. */
export function exportUrl(apiBaseUrl: string, format: "json" | "csv"): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/v1/export/opportunities.${format}`;
}
