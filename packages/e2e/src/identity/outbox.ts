/**
 * Reading a one-time code back out of the API's file transport.
 *
 * THIS FILE IS WHY THE SUITE NEEDS NO EXTERNAL CONFIGURATION. The old harness borrowed a real
 * identity tenant: it needed an app id, an app secret, an acknowledgement variable, a fixed test
 * address and a fixed code, and the number of distinct identities it could obtain was whatever
 * somebody had created in a dashboard. Sign-in codes now originate inside the run — the API is
 * booted with `EMAIL_TRANSPORT=file` and an outbox inside the run's own `0700` directory — so an
 * identity is just an address nobody has used before, and there can be as many as a spec wants.
 *
 * THE OUTBOX LIVES INSIDE `ctx.tmp`, never in a shared or OS temp location. That directory is
 * created exclusively per run, carries an ownership marker, and is removed by the runner's `finally`
 * on every path including `SIGINT` — so live sign-in codes cannot outlive the run that produced
 * them. `EMAIL_OUTBOX_DIR` is never set in a deployment; `config.ts` refuses to boot a production
 * process with a revealing transport at all.
 *
 * CONSUME OTP MAIL ONLY. A consumed code must not be readable by a later assertion that did not
 * send it, but duplicate notifications share the address's JSONL file and must not be mistaken for
 * codes or deleted as collateral. OTP subjects are filtered explicitly; after a code is read, all
 * OTP lines are removed and unrelated mail is preserved.
 *
 * POLLING, NOT A WATCHER. `fs.watch` semantics differ per platform and miss writes that landed
 * before the watcher attached — and the send is deliberately not awaited by the API (it must not be
 * an enumeration oracle), so the file appears strictly after the request resolves. A short poll is
 * both simpler and correct on every platform this runs on.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long to wait for a code before giving up. The API writes it within milliseconds of the send. */
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

/** The digits a code is made of. `OTP_LENGTH` in `packages/api/src/auth/better-auth.ts`. */
const OTP_PATTERN = /\b(\d{6})\b/;
const OTP_SUBJECTS: ReadonlySet<string> = new Set([
  "Your RFP Hub sign-in code",
  "Confirm your RFP Hub email address",
  "Confirm your new RFP Hub email address",
]);

/**
 * The file the transport writes for one address.
 *
 * Mirrors `outboxFileFor` in the API's central email transport: one file per address, named by a
 * digest rather than the address itself, because file NAMES are the part that survives a screenshot
 * or a stray `ls` in a log. Mirrored rather than imported — that module lives in another package's
 * `src`, which is not an exported entry point — and the mirroring is self-checking: if the naming
 * drifted, no code would ever be found and every sign-in here would fail loudly.
 */
export function outboxFileFor(dir: string, email: string): string {
  return join(dir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.jsonl`);
}

export interface WaitForOtpOptions {
  timeoutMs?: number;
}

export interface OutboxEmail {
  to: string;
  subject: string;
  text: string;
}

export interface WaitForEmailOptions extends WaitForOtpOptions {
  /** All fragments must occur in the body; lets a shared outbox distinguish same-subject events. */
  textIncludes?: readonly string[];
}

/**
 * Waits for the newest code sent to `email`, returns it, and consumes OTP messages only.
 *
 * The LAST line is taken, not the first: a spec may legitimately ask for a second code (the "use a
 * different address" path, or the attempt-limit case), and the newest is the live one.
 */
export async function waitForOtp(
  dir: string,
  email: string,
  options: WaitForOtpOptions = {},
): Promise<string> {
  const path = outboxFileFor(dir, email);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  for (;;) {
    const found = readNewestCode(path);
    if (found) {
      preserveLines(path, found.remaining);
      return found.code;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `outbox: no sign-in code arrived for ${email} within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms. Expected a line in ${path}. The API is booted with EMAIL_TRANSPORT=file and EMAIL_OUTBOX_DIR pointing at this directory; if that is not so, no code can ever appear here.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Wait for and consume one non-OTP message with the exact subject. */
export async function waitForEmail(
  dir: string,
  email: string,
  subject: string,
  options: WaitForEmailOptions = {},
): Promise<OutboxEmail> {
  const path = outboxFileFor(dir, email);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  for (;;) {
    let lines: string[] = [];
    try {
      lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
    } catch {
      // The immediate dispatcher has not written this address's outbox yet.
    }

    for (let index = 0; index < lines.length; index++) {
      let message: Partial<OutboxEmail>;
      try {
        message = JSON.parse(lines[index] as string) as Partial<OutboxEmail>;
      } catch {
        continue;
      }
      if (
        message.to === email &&
        message.subject === subject &&
        typeof message.text === "string" &&
        (options.textIncludes ?? []).every((fragment) => message.text?.includes(fragment))
      ) {
        preserveLines(
          path,
          lines.filter((_, lineIndex) => lineIndex !== index),
        );
        return { to: email, subject, text: message.text };
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `outbox: no ${JSON.stringify(subject)} email arrived for ${email} within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

interface ReadCode {
  code: string;
  /** Original JSONL lines with every OTP message removed; notification mail stays byte-for-byte. */
  remaining: string[];
}

/** The newest OTP code, filtered by subject, plus the unrelated messages that must survive. */
function readNewestCode(path: string): ReadCode | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // Not written yet. The ordinary case on the first few polls.
  }

  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  let code: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    // A torn final line from a concurrent append is skipped rather than throwing; the next poll
    // sees it whole.
    let message: { subject?: unknown; text?: unknown };
    try {
      message = JSON.parse(lines[index] as string);
    } catch {
      remaining.push(lines[index] as string);
      continue;
    }
    if (
      typeof message.subject !== "string" ||
      !OTP_SUBJECTS.has(message.subject) ||
      typeof message.text !== "string"
    ) {
      remaining.push(lines[index] as string);
      continue;
    }
    const found = OTP_PATTERN.exec(message.text);
    if (found?.[1]) code = found[1];
    else remaining.push(lines[index] as string);
  }
  return code ? { code, remaining } : undefined;
}

/**
 * Removes any code queued for an address without consuming it as a sign-in.
 *
 * Used where a spec has deliberately caused a send it does not intend to use — so a later
 * `waitForOtp` cannot pick up the stale one and report success for the wrong reason.
 */
export function discardOtp(dir: string, email: string): void {
  const path = outboxFileFor(dir, email);
  const found = readNewestCode(path);
  if (found) preserveLines(path, found.remaining);
}

function preserveLines(path: string, lines: string[]): void {
  if (lines.length === 0) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  }
}
