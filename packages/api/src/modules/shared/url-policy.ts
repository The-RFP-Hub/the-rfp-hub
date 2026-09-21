/**
 * Which stored URLs this hub is willing to publish: `https:` only, everywhere.
 *
 * WHY THIS IS NOT IN THE SCHEMA. The standard types every one of these fields as `format: uri`,
 * and `uri` is RFC 3986 — `javascript:alert(1)`, `data:text/html;base64,…`, `vbscript:`, `file:`
 * and `ftp:` are all well-formed URIs and all pass it. Tightening the schema itself would be a
 * SPEC change: third-party documents validate against the published artifact, so a new `pattern`
 * there breaks conformance for everyone and needs a version bump. This is hub INGEST POLICY
 * instead — what we accept into our database and republish under our name — and it lives here so
 * the seed loader and the write path enforce one rule rather than two.
 *
 * WHY `https:` AND NOT MERELY "A WEB SCHEME". Two reasons, and only the first is about attacks.
 * A stored `javascript:` or `data:` value is inert on our own surfaces — the link-out redirect
 * 404s anything that is not http(s) and the frontend renders it as text rather than a link — but
 * it is NOT inert downstream: these values ship raw in the RSS/Atom/JSON feeds, in
 * `/v1/opportunities/:id` and in the open-data export, where a consumer that renders a feed entry
 * as `<a href>` turns our data into a click-to-execute link carrying our name. The second reason
 * is plainer: `http:` under a counted redirect on our own domain is a downgrade a network can
 * rewrite, and the published corpus is already 100% `https:` across every one of these fields, so
 * requiring it costs no existing record and needs no backfill.
 *
 * THE LOOPBACK EXEMPTION is the same one `config.ts` states for `PUBLIC_BASE_URL`, in the same
 * words and through the same predicate: `https:` anywhere, `http:` on loopback, nothing else.
 * Plaintext to a host that is not reachable off the machine crosses no network segment on which it
 * could be observed or tampered with, and refusing it would make a local development stack and the
 * e2e run — which stands up a real fixture web server on 127.0.0.1 and points records at it —
 * impossible to express. A loopback URL published to a reader is inert rather than dangerous: it
 * addresses the reader's own machine.
 */
import { isLoopbackHost } from "../../shared/loopback.js";

/** Every `format: uri` location in a Standard opportunity, as a JSON Pointer producer. */
type UrlSite = { path: string; value: unknown };

const DOCUMENT_URL_FIELDS = ["applicationUrl", "website", "logoUrl", "bannerUrl"] as const;
const ORGANIZATION_URL_FIELDS = ["website", "logoUrl", "bannerUrl"] as const;
const ORGANIZATION_ARRAYS = ["operatingOrganizations", "sponsoringOrganizations"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `socialLinks[].url` under `prefix`, which is either the document or one organization. */
function socialLinkSites(prefix: string, holder: Record<string, unknown>): UrlSite[] {
  const links = holder.socialLinks;
  if (!Array.isArray(links)) return [];
  return links.flatMap((link, index) => {
    const entry = asRecord(link);
    return entry === undefined
      ? []
      : [{ path: `${prefix}/socialLinks/${index}/url`, value: entry.url }];
  });
}

/**
 * Every URL a publisher can put in a document.
 *
 * `$schema` is deliberately absent: it identifies the contract the document claims to conform to,
 * is ignored by validation, and is not a link this hub ever republishes as a destination.
 */
function urlSites(record: Record<string, unknown>): UrlSite[] {
  const sites: UrlSite[] = DOCUMENT_URL_FIELDS.map((field) => ({
    path: `/${field}`,
    value: record[field],
  }));
  sites.push(...socialLinkSites("", record));

  for (const arrayField of ORGANIZATION_ARRAYS) {
    const orgs = record[arrayField];
    if (!Array.isArray(orgs)) continue;
    orgs.forEach((org, index) => {
      const entry = asRecord(org);
      if (entry === undefined) return;
      const prefix = `/${arrayField}/${index}`;
      for (const field of ORGANIZATION_URL_FIELDS) {
        sites.push({ path: `${prefix}/${field}`, value: entry[field] });
      }
      sites.push(...socialLinkSites(prefix, entry));
    });
  }

  const source = asRecord(record.source);
  if (source !== undefined) {
    sites.push({ path: "/source/snapshotUrl", value: source.snapshotUrl });
  }
  return sites;
}

/** One refused URL, addressed to the field that holds it. */
export interface UrlPolicyProblem {
  path: string;
  message: string;
}

/**
 * The authority form — `scheme://host/…` — and nothing looser.
 *
 * `new URL("https:example.org/apply")` yields protocol `https:` and host `example.org`, so a
 * protocol test alone accepts it. It is a RELATIVE reference, and the RAW STRING is what ships in
 * the feeds and the export: a consumer resolving it against their own base lands on
 * `https://reader.example/folder/example.org/apply` instead. Requiring the `//` closes that
 * discrepancy, and it costs nothing — it is what everybody writing a URL means anyway.
 */
const AUTHORITY_FORM = /^https?:\/\//i;

/** True when `value` is a URL this hub will store and republish. */
export function isPublishableUrl(value: string): boolean {
  if (!AUTHORITY_FORM.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/**
 * Why one value was refused, in terms of the mistake the publisher actually made.
 *
 * The three are worth telling apart: a wrong SCHEME is a different fix from a plaintext host, and
 * both are a different fix from `https:example.org` — which names the right scheme and is still
 * refused, so a message about schemes would send its author looking in the wrong place.
 */
function refusalFor(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute `https://` URL.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `must be an \`https://\` URL — the ${url.protocol} scheme is not published.`;
  }
  if (!AUTHORITY_FORM.test(value)) {
    return "must be written in full, as `https://host/path` — this form is a relative reference.";
  }
  return "must use `https:`, not `http:` (which is accepted only on loopback).";
}

/**
 * Every URL in `record` that this hub will not publish. Empty for a conformant document.
 *
 * Null, undefined and absent stay silent — these fields are optional and their optionality is the
 * schema's business, not this policy's. A non-string reaching here is a schema violation the
 * validator reports in its own words, so it is skipped rather than described twice.
 */
export function urlPolicyProblems(record: Record<string, unknown>): UrlPolicyProblem[] {
  const problems: UrlPolicyProblem[] = [];
  for (const { path, value } of urlSites(record)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    if (isPublishableUrl(value)) continue;

    problems.push({ path, message: refusalFor(value) });
  }
  return problems;
}
