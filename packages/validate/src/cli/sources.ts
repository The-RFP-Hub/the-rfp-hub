import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Expand inputs (files and directories) into a flat, sorted list of JSON file paths. */
export function expandInputs(targets: string[]): string[] {
  const out: string[] = [];
  for (const target of targets) {
    const stat = statSync(target); // throws if missing — caller handles
    if (stat.isDirectory()) {
      for (const name of readdirSync(target)
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        out.push(join(target, name));
      }
    } else {
      out.push(target);
    }
  }
  return out;
}

function toEntries(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Read a JSON file into a list of entries (single object → one entry; array → many). */
export function readEntries(file: string): unknown[] {
  return toEntries(JSON.parse(readFileSync(file, "utf8")));
}

/** Read entries from stdin. Throws if empty or invalid. */
export function readStdin(): unknown[] {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  if (!raw.trim()) {
    throw new Error("no input; pass file(s)/dir(s) or pipe JSON to stdin (see --help)");
  }
  return toEntries(JSON.parse(raw));
}
