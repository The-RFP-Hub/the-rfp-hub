/**
 * Markdown link extraction — pure, no I/O.
 *
 * Used by the docs check (checks/docs.mjs) to find every link a handoff guide makes, so each one
 * can be resolved (relative) or requested (absolute) independently of how it was written. This
 * module only PARSES; it never fetches or touches the filesystem, which is what makes it testable
 * without a network or a repo checkout.
 */

/** `[text](href)` and bare autolinks `<https://...>`. Reference-style `[text][ref]` is out of scope
 * — none of the docs this checker reads use it, and adding support for a form the fixtures never
 * exercise would be untested code. */
export function extractLinks(markdown) {
  const links = [];
  const seen = new Set();
  const add = (href, kind) => {
    const key = `${kind}:${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ href, kind });
  };

  // Inline links: [text](href "title"). The href stops at whitespace or a closing paren not
  // preceded by an escape; a title in quotes is discarded.
  const inline = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match = inline.exec(markdown);
  while (match !== null) {
    add(match[2], "inline");
    match = inline.exec(markdown);
  }

  // Autolinks: <https://example.org>
  const autolink = /<((?:https?|mailto):[^\s<>]+)>/g;
  match = autolink.exec(markdown);
  while (match !== null) {
    add(match[1], "autolink");
    match = autolink.exec(markdown);
  }

  return links;
}

/** True for `https://…` / `http://…`; false for a relative path, an anchor, or `mailto:`. */
export function isAbsoluteHttpLink(href) {
  return /^https?:\/\//i.test(href);
}

/** True for a same-document anchor (`#section`), which resolves by definition and is never fetched. */
export function isAnchorLink(href) {
  return href.startsWith("#");
}

/**
 * Resolve a relative link against the markdown file's own path, returning the path relative to
 * `repoRoot`. Strips a trailing `#fragment` before resolving — the fragment is not a filesystem
 * segment. Pure string/path arithmetic; the caller checks existence.
 */
export function resolveRelativeLink(href, { fileDir, repoRoot, path }) {
  const withoutFragment = href.split("#")[0];
  if (withoutFragment === "") return null; // pure same-file anchor, already handled by isAnchorLink
  const absolute = path.resolve(fileDir, withoutFragment);
  return path.relative(repoRoot, absolute);
}
