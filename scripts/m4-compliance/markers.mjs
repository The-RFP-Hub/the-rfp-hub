/**
 * Marker parsing for ` ```sh ` blocks in the handoff docs — pure, no I/O. The convention is the
 * docs stream's own: the marker is the SECOND WORD OF THE INFO STRING (` ```sh safe-read `) and
 * there is no preceding-comment form. `safe-read` is the only kind this checker executes;
 * `staging-write` and `no-run` are never run. See scripts/m4-compliance/README.md for the scope.
 */

export const MARKERS = ["safe-read", "no-run", "staging-write"];

/** Every fenced block, with its language, marker (or `null`) and 1-based opening-fence line. */
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
