/**
 * Marker parsing for ` ```sh ` code blocks in the handoff docs — pure, no I/O.
 *
 * The contract (confirmed against `docs/README.md` on the `m4-handoff-docs` branch, which is the
 * stream that actually owns `docs/**`): every fenced `sh`/`bash` block carries the marker as the
 * SECOND WORD OF THE INFO STRING — ` ```sh safe-read ` — and nothing else. There is no
 * preceding-comment form; an earlier revision of this file supported one speculatively, before the
 * docs stream's own convention could be read, and it is gone now that the real one is known.
 *
 *   safe-read      a GET against a public endpoint, no credential — the ONLY kind this checker runs
 *   staging-write  mints a key, requests an OTP, submits/reviews/revokes — never run automatically
 *   no-run         deployment or infrastructure mutation — never run automatically, ever
 *
 * A `sh`/`bash` block with no marker (or an unrecognized second word) is a hard failure — an
 * unmarked block is one this checker cannot tell is safe to run, and treating "unmarked" as "don't
 * run" silently would let a real safe-read command go unexercised without anyone noticing.
 */

export const MARKERS = ["safe-read", "no-run", "staging-write"];

/**
 * Extract every fenced code block from markdown, with its language, its marker (the second word of
 * the info string, when it is one of `MARKERS`; otherwise `null`), and its source line number
 * (1-based, of the opening fence).
 */
export function parseMarkedBlocks(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const fenceMatch = /^```(\S*)\s*(\S*)\s*$/.exec(lines[i]);
    if (!fenceMatch) {
      i++;
      continue;
    }
    const [, lang, infoMarker] = fenceMatch;
    const openLine = i + 1; // 1-based
    const bodyLines = [];
    let j = i + 1;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) {
      bodyLines.push(lines[j]);
      j++;
    }

    blocks.push({
      lang,
      marker: MARKERS.includes(infoMarker) ? infoMarker : null,
      line: openLine,
      source: bodyLines.join("\n"),
    });

    i = j + 1;
  }
  return blocks;
}

/** Just the `sh`/`shell`/`bash`/`console` blocks — the ones the marker rule actually governs. */
export function shellBlocks(markdown) {
  return parseMarkedBlocks(markdown).filter((b) =>
    ["sh", "shell", "bash", "console"].includes(b.lang),
  );
}
