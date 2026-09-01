/**
 * Markdown link extraction and fragment resolution — pure, no I/O.
 *
 * Used by the docs check to find every link a handoff guide makes, so each one can be resolved
 * (relative), requested (absolute) or matched against a heading (fragment). Parsing only; the
 * caller does the filesystem and the network, which is what makes this testable without either.
 *
 * Code fences and inline code are skipped: a `curl https://…` inside a `safe-read` block is an
 * example, not a link the guide promises resolves.
 */

/** Blank out fenced blocks so their contents are never mistaken for links or headings. */
function withoutFences(markdown) {
  return markdown.replace(/^(~~~|```)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

/** …and inline code too, for link extraction: a `curl https://…` example is not a promise. */
function withoutCode(markdown) {
  return withoutFences(markdown).replace(/`[^`\n]*`/g, (span) => " ".repeat(span.length));
}

/**
 * Every link, by kind: `inline` (`[t](href)`), `autolink` (`<https://…>`), `reference`
 * (`[t][ref]` / `[ref]`, resolved through its `[ref]: href` definition) and `bare` (a URL written
 * as prose). Reference and bare forms are here because a guide that uses one still promises it
 * resolves, and the previous parser silently ignored both.
 */
export function extractLinks(markdown) {
  const text = withoutCode(markdown);
  const links = [];
  const seen = new Set();
  const add = (href, kind) => {
    if (!href) return;
    const key = `${kind}:${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ href, kind });
  };

  const definitions = new Map();
  const definition = /^\s{0,3}\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm;
  for (const match of text.matchAll(definition)) {
    definitions.set(match[1].toLowerCase(), match[2]);
  }

  for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    add(match[2], "inline");
  }
  for (const match of text.matchAll(/\[([^\]]*)\]\[([^\]]*)\]/g)) {
    const ref = (match[2] || match[1]).toLowerCase();
    add(definitions.get(ref) ?? `[unresolved reference: ${ref}]`, "reference");
  }
  // Shortcut form, `[deploy]`, which carries its own label as the reference.
  for (const match of text.matchAll(/\[([^\]]+)\](?![[(:])/g)) {
    const href = definitions.get(match[1].toLowerCase());
    if (href) add(href, "reference");
  }
  for (const match of text.matchAll(/<((?:https?|mailto):[^\s<>]+)>/g)) {
    add(match[1], "autolink");
  }
  // A bare URL in prose: not already inside `](…)`, `<…>` or a definition, and not trailing
  // sentence punctuation.
  const stripped = text
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(definition, " ");
  for (const match of stripped.matchAll(/(?<![\w/])(https?:\/\/[^\s<>"')\]]+)/g)) {
    add(match[1].replace(/[.,;:]+$/, ""), "bare");
  }

  return links;
}

/** A reference link whose definition is missing — reported by name rather than dropped. */
export function isUnresolvedReference(href) {
  return href.startsWith("[unresolved reference: ");
}

/** True for `https://…` / `http://…`; false for a relative path, an anchor, or `mailto:`. */
export function isAbsoluteHttpLink(href) {
  return /^https?:\/\//i.test(href);
}

/** True for a same-document anchor (`#section`) — resolved against THIS file's own headings. */
export function isAnchorLink(href) {
  return href.startsWith("#");
}

/**
 * GitHub's heading anchor rule: lowercase, punctuation dropped, spaces to hyphens, and a repeated
 * slug suffixed `-1`, `-2`, … in document order. Reimplemented rather than assumed, because
 * "the fragment resolves by definition" was how every anchor in the guides passed before.
 */
export function githubSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Every anchor a markdown document offers, in document order, with GitHub's duplicate suffixes. */
export function headingSlugs(markdown) {
  const slugs = new Set();
  const counts = new Map();
  // Fences only: a heading legitimately carries inline code, and blanking it would change the
  // anchor GitHub actually generates for `### 4.6 The counted path is \`/v1/r/:id/apply\``.
  for (const match of withoutFences(markdown).matchAll(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const base = githubSlug(match[2]);
    if (!base) continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

/**
 * Resolve a relative link against the markdown file's own path.
 *
 * Returns `{ path, fragment, escapesRepo }` — `path` relative to `repoRoot`, `fragment` without
 * its `#`, and `escapesRepo` true when `../` walked out of the checkout, which is a broken link on
 * the published mirror however well it resolves on the author's disk.
 */
export function resolveRelativeLink(href, { fileDir, repoRoot, path }) {
  const [target, fragment] = splitFragment(href);
  if (target === "") return null; // pure same-file anchor, already handled by isAnchorLink
  const absolute = path.resolve(fileDir, target);
  const relative = path.relative(repoRoot, absolute);
  return {
    path: relative,
    fragment,
    escapesRepo:
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
  };
}

export function splitFragment(href) {
  const index = href.indexOf("#");
  return index === -1 ? [href, undefined] : [href.slice(0, index), href.slice(index + 1)];
}
