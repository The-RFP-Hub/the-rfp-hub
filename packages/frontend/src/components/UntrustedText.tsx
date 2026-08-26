/**
 * Publisher-supplied text, rendered as text.
 *
 * The Standard says `description` is untrusted and must be sanitised before rendering, and every
 * other string on a listing — title, summary, eligibility, an organisation's name — arrives by the
 * same route and deserves the same treatment. React escapes a text child, so the sanitisation is
 * simply never leaving that path: no `dangerouslySetInnerHTML`, no markdown-to-HTML step, no
 * "trusted publisher" exception. A unit test scans this package's source to keep it that way.
 *
 * Markdown is therefore shown as the characters the publisher typed. That is a deliberate downgrade
 * of presentation in exchange for a guarantee: rendering markdown safely means an allowlisting
 * renderer with raw HTML disabled, and adding one is a change that must be reviewed as such rather
 * than arriving quietly inside a layout tweak.
 *
 * `white-space: pre-wrap` keeps the author's line breaks, which is most of what markdown was doing
 * for a description anyway.
 */
export function UntrustedText({
  value,
  className,
  fallback = "—",
}: {
  value: string | null | undefined;
  className?: string;
  /** What to show when the publisher left the field empty. Never invented content. */
  fallback?: string;
}) {
  if (value === null || value === undefined || value.trim() === "") {
    return <span className="muted untrusted-text">{fallback}</span>;
  }
  return <span className={[className, "untrusted-text"].filter(Boolean).join(" ")}>{value}</span>;
}

/** The multi-line variant, for descriptions and other long free text. */
export function UntrustedBlock({
  value,
  fallback = "No description was provided.",
}: {
  value: string | null | undefined;
  fallback?: string;
}) {
  if (value === null || value === undefined || value.trim() === "") {
    return <p className="muted">{fallback}</p>;
  }
  return <p className="untrusted-block">{value}</p>;
}

/**
 * A publisher-supplied URL, shown as its own text and linked with `rel="noopener noreferrer"`.
 *
 * Only http(s) is linked. A `javascript:` or `data:` URL in a stored record would otherwise become
 * a click-to-execute link, and the check belongs here rather than in every caller.
 */
export function UntrustedLink({
  href,
  label,
}: { href: string | null | undefined; label?: string }) {
  if (!href) return <span className="muted untrusted-link">—</span>;
  let safe = false;
  try {
    const parsed = new URL(href);
    safe = parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    safe = false;
  }
  if (!safe) {
    return (
      <span
        className="muted untrusted-link"
        title="Not an http(s) URL, so it is shown but not linked"
      >
        {href}
      </span>
    );
  }
  return (
    <a className="untrusted-link" href={href} target="_blank" rel="noopener noreferrer">
      {label ?? href}
    </a>
  );
}
