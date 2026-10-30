/**
 * The hub's URL rules as this frontend needs them: which stored URLs are worth linking to, and how
 * to name where one goes.
 *
 * `isPublishableUrl` is the hub's INGEST POLICY, mirrored: `https://`, or `http://` on loopback —
 * the same rule the API applies in `modules/shared/url-policy.ts`, and stricter than the schema's
 * `format: uri` on purpose. `uri` is RFC 3986, so it admits `javascript:` and `data:`, and these
 * values are republished in the feeds and the open-data export. Mirrored rather than shared because
 * the two packages ship separately. It has two callers here and one implementation:
 *
 *   - the submission form, where it puts the API's answer next to the input instead of in a 400 —
 *     the API refuses the same values whatever this function says, so drift there costs a
 *     confusing message rather than an unsafe record;
 *   - the `/leaving/[id]` page, where it decides whether a stored value is offered as a link at
 *     all. There, drift in the LOOSE direction would matter, which is why this is the same function
 *     the form has always used and not a second copy written for the occasion.
 *
 * The loopback arm exists so a local stack can be described, and followed, in the form it actually
 * runs under.
 */

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?)$/i;

/** True when `value` is a URL the hub would store, republish and redirect to. */
export function isPublishableUrl(value: string): boolean {
  // The AUTHORITY FORM, not merely something `new URL` parses: it rejects `/apply` and
  // `example.org` on their own, which is the pair a publisher gets wrong, and also
  // `https:example.org`, which names the right scheme but is a relative reference.
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    // Mirrors `api/src/shared/loopback.ts`, including the ROOT-ANCHORED form: `localhost.` is the
    // same name written as an FQDN, and a resolver treats the two identically.
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    return (
      url.protocol === "http:" &&
      (host === "localhost" || host.endsWith(".localhost") || LOOPBACK.test(host))
    );
  } catch {
    return false;
  }
}

/**
 * Where a link goes, as a reader should be shown it: the whole host, or `null` when there is no
 * honest answer.
 *
 * IT IS THE PARSER'S HOST, NOT A SUBSTRING OF WHAT THE PUBLISHER TYPED, and that is the security
 * property rather than a detail. `https://airtable.com@evil.example/` names `airtable.com` first
 * and goes to `evil.example`; `new URL` says `evil.example`, and so does this. The parser also
 * lowercases and converts a non-ASCII name to its `xn--` form, so a Cyrillic look-alike of a
 * well-known domain is shown as the punycode it really is rather than as the brand it imitates.
 * That is uglier and correct: this string exists to tell a reader where they are about to be.
 *
 * `host` rather than `hostname`, so a non-default port stays in view — `example.org:8443` is not
 * the same place as `example.org`.
 *
 * NOTHING IS TRIMMED, not even a leading `www.`. Dropping it read better for the shared platforms
 * (`www.typeform.com` → `typeform.com`), but whether `www.` is decoration or part of the
 * registrable name depends on the public suffix list: `www.co.uk` became `co.uk`, `www.github.io`
 * became `github.io`, `www.com.` became `com.` — each a different place from the one the link goes
 * to, shown on the very controls that exist to say where it goes. Getting that right needs the
 * suffix list; showing the host as the parser gives it is right without one.
 *
 * `null` for anything without a web origin (`mailto:`, `javascript:`, a relative reference, a
 * string that does not parse): callers fall back to wording that names no host rather than
 * inventing one.
 */
export function linkHost(value: string | null | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value.trim())) return null;
  try {
    const host = new URL(value.trim()).host;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}
