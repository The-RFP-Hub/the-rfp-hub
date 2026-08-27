/**
 * Marker parsing for ` ```sh ` code blocks in the handoff docs — pure, no I/O.
 *
 * The M4 plan (§3.6) requires every `sh` block in `docs/**` to carry one of three markers, because
 * a checker that runs a doc's shell blocks verbatim must never run a mutation or an infra command:
 *
 *   safe-read      a GET against a public endpoint, no credential — the ONLY kind this checker runs
 *   staging-write  mints a key, requests an OTP, submits/reviews/revokes — never run automatically
 *   no-run         deployment or infrastructure mutation — never run automatically, ever
 *
 * THE CONVENTION (this checker is the first consumer, so it also defines the syntax the docs
 * stream writes to — see scripts/m4-compliance/README.md):
 *
 *   1. On the fence's own info string, as a second token after the language:
 *      ```sh safe-read
 *      curl https://api.example.org/v1/health
 *      ```
 *
 *   2. Or, when the fence itself can't carry it (e.g. a language-less fence), an HTML comment on
 *      its own line immediately before the fence, allowing one blank line in between:
 *      <!-- marker: staging-write -->
 *      ```sh
 *      curl -X POST https://api.example.org/v1/keys ...
 *      ```
 *
 * A `sh` block with neither is a hard failure — see `parseMarkedBlocks`' `unmarked` output — because
 * an unmarked block is one the checker cannot tell is safe to run, and treating "unmarked" as
 * "don't run" silently would let a real safe-read command go unexercised without anyone noticing.
 */

export const MARKERS = ["safe-read", "no-run", "staging-write"];

/**
 * Extract every fenced code block from markdown, with its language, its marker (if any, resolved
 * per the convention above), and its source line number (1-based, of the opening fence).
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

    let marker = MARKERS.includes(infoMarker) ? infoMarker : null;
    if (!marker) {
      // Look at up to two lines before the fence for `<!-- marker: X -->`, skipping one blank line.
      for (const candidateIdx of [i - 1, i - 2]) {
        if (candidateIdx < 0) continue;
        const candidate = lines[candidateIdx];
        if (candidate.trim() === "" && candidateIdx === i - 1) continue;
        const commentMatch = /^<!--\s*marker:\s*(\S+)\s*-->\s*$/.exec(candidate.trim());
        if (commentMatch && MARKERS.includes(commentMatch[1])) {
          marker = commentMatch[1];
        }
        break;
      }
    }

    blocks.push({
      lang,
      marker,
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
