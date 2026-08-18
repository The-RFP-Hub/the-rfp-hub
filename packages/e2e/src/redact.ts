/**
 * The run's shared secret registry, and the redaction built on top of it.
 *
 * WHY THIS IS FILE-BACKED RATHER THAN A MODULE-LEVEL SET.
 *
 * A run is several processes: the external runner (`run.ts`), the Playwright runner it spawns, and
 * — because Playwright loads each project in its own worker — one or more worker processes that
 * actually mint credentials. An API key minted inside a worker exists only in that worker's heap.
 * If the registry were an in-memory set, the runner's end-of-run artifact scan would be scanning
 * for a list of secrets that does not include the ones a worker created, and would report "clean"
 * about exactly the material most likely to have leaked. That is a scanner that lies, which is
 * worse than no scanner.
 *
 * So every process appends to ONE file, and every reader re-reads it. The file lives in the run's
 * 0700 temp directory, OUTSIDE the repository (see `run.ts`), is created 0600, and is removed with
 * the rest of the temp directory in the runner's `finally`.
 *
 * WHAT IS AND IS NOT GUARANTEED.
 *
 * `redact()` is a best-effort scrub of text this suite writes (its own reporter, its own log
 * lines). It is NOT a claim about Playwright's traces: Playwright records request headers itself,
 * offers no redaction hook, and therefore keeps short-lived Privy access tokens inside failure
 * traces. That residue is stated in the README and the report rather than papered over. The
 * scanner's guarantee (`scan-artifacts.ts`) is deliberately scoped to LONG-LIVED secrets — the app
 * secret, the OTP, and minted `rfph_…` keys, all of which outlive the run.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The environment variable that points every process in a run at the same registry file.
 *
 * It is an ENV var rather than an argument because the processes that need it are not all spawned
 * by code that could pass one: Playwright spawns its own workers, and a worker has no channel back
 * to the runner other than the environment it inherited.
 */
export const REGISTRY_ENV = "E2E_SECRETS_FILE";

export interface RegisteredSecret {
  /** What this secret is, for the placeholder text. Never the value. */
  label: string;
  value: string;
  /** True when the secret outlives the run and a leak into an artifact is a real finding. */
  longLived: boolean;
}

/** Minimum length for a value worth registering: shorter strings redact half the world. */
const MIN_SECRET_LENGTH = 8;

let inMemory: RegisteredSecret[] = [];
let loadedFrom: string | undefined;

function registryPath(): string | undefined {
  return process.env[REGISTRY_ENV];
}

/**
 * Creates (or truncates) this run's registry file and points the current process at it.
 *
 * Called once, by the runner, before anything is spawned. Truncating is intentional: a stale file
 * from an earlier run under a reused `E2E_RUN_ID` would make the scanner search for secrets that
 * are no longer in play, and — worse — would keep those values on disk longer than the run that
 * created them.
 */
export function initRegistry(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "", { mode: 0o600 });
  process.env[REGISTRY_ENV] = path;
  inMemory = [];
  loadedFrom = undefined;
}

/**
 * Records a secret so every process in this run can redact and scan for it.
 *
 * Idempotent by value. Registering the same token twice (a fixture re-reading it, two specs
 * sharing a key) appends nothing the second time, so the file does not grow without bound over a
 * long run.
 */
export function register(
  value: string | undefined | null,
  options: Omit<RegisteredSecret, "value">,
): void {
  if (!value || value.length < MIN_SECRET_LENGTH) return;

  const entry: RegisteredSecret = { value, label: options.label, longLived: options.longLived };
  const known = all();
  if (known.some((s) => s.value === value)) return;

  inMemory.push(entry);

  const path = registryPath();
  if (!path) return;
  // One JSON object per line, appended. Append is atomic enough for lines this short on every
  // platform this suite runs on, and the format survives a partially-written final line: `all()`
  // drops anything it cannot parse rather than throwing in the middle of a scan.
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Registers a value and hands it straight back, so a call site can wrap a mint expression. */
export function registerAndReturn<T extends string>(
  value: T,
  options: Omit<RegisteredSecret, "value">,
): T {
  register(value, options);
  return value;
}

/**
 * Every secret this run knows about: this process's own, plus every other process's.
 *
 * Re-reads the file on each call. That is deliberate — the whole point is to see what a DIFFERENT
 * process appended after this one last looked, and the file is a few hundred bytes.
 */
export function all(): RegisteredSecret[] {
  const path = registryPath();
  if (!path) return [...inMemory];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // No file yet (a worker that starts before the first mint) is not an error.
    return [...inMemory];
  }
  loadedFrom = path;

  const merged = new Map<string, RegisteredSecret>();
  for (const secret of inMemory) merged.set(secret.value, secret);
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RegisteredSecret;
      if (typeof parsed?.value === "string" && parsed.value.length >= MIN_SECRET_LENGTH) {
        merged.set(parsed.value, parsed);
      }
    } catch {
      // A torn final line from a concurrent append. Skipping it loses nothing: the writer that
      // tore it will have the value in its own `inMemory`, and the next read sees the whole line.
    }
  }
  return [...merged.values()];
}

/** Just the secrets whose leak into an artifact is a real finding. See the header. */
export function longLived(): RegisteredSecret[] {
  return all().filter((s) => s.longLived);
}

/**
 * Structural patterns applied on top of the registry.
 *
 * The registry catches what this suite minted. These catch what it did not: a token that arrived
 * from the browser, an `rfph_…` key echoed by a route the suite never called directly. They are
 * intentionally narrow — anchored on this project's own key prefix and on the JWT shape — because
 * a loose pattern that redacts opportunity ids out of a report makes the report useless.
 */
const STRUCTURAL: Array<[RegExp, string]> = [
  [/rfph_[A-Za-z0-9_-]{16,}/g, "[redacted:api-key]"],
  // Three base64url segments: a signed JWT. Privy access tokens and this suite's forged ones both.
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted:jwt]"],
];

/**
 * Replaces every known secret in `text` with a labelled placeholder.
 *
 * Longest-first, so a secret that contains another secret as a substring cannot leave a fragment
 * of the longer one behind after the shorter one has been replaced.
 */
export function redact(text: string): string {
  let out = text;
  for (const secret of all().sort((a, b) => b.value.length - a.value.length)) {
    if (!secret.value) continue;
    out = out.split(secret.value).join(`[redacted:${secret.label}]`);
  }
  for (const [pattern, placeholder] of STRUCTURAL) {
    out = out.replace(pattern, placeholder);
  }
  return out;
}

/** Redacts anything JSON-serialisable by round-tripping it through `redact`. */
export function redactJson<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}

/**
 * A value safe to print: the last four characters only, and only when it is long enough that four
 * characters cannot reconstruct it. Used for the Privy app id in the preflight report, which is an
 * identifier rather than a secret but still not something to echo in full into a log a person
 * might paste somewhere.
 */
export function mask(value: string | undefined): string {
  if (!value) return "(absent)";
  if (value.length <= 8) return "(present)";
  return `…${value.slice(-4)}`;
}

/** Presence reporting: the ONLY thing a preflight is allowed to say about a credential. */
export function presence(value: string | undefined | null): "present" | "absent" {
  return value ? "present" : "absent";
}

/** For diagnostics only — which file this process is actually reading. Never the contents. */
export function registryFile(): string | undefined {
  return registryPath() ?? loadedFrom;
}
