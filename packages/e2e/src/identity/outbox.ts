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
 * DELETE ON READ. A consumed code must not be readable by a later assertion that did not send it —
 * otherwise a spec asserting "signing in again needs a fresh code" could pass by re-reading the
 * previous one. The file for an address is removed once its last line has been taken.
 *
 * POLLING, NOT A WATCHER. `fs.watch` semantics differ per platform and miss writes that landed
 * before the watcher attached — and the send is deliberately not awaited by the API (it must not be
 * an enumeration oracle), so the file appears strictly after the request resolves. A short poll is
 * both simpler and correct on every platform this runs on.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** How long to wait for a code before giving up. The API writes it within milliseconds of the send. */
const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 100;

/** The digits a code is made of. `OTP_LENGTH` in `packages/api/src/auth/better-auth.ts`. */
const OTP_PATTERN = /\b(\d{6})\b/;

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

/**
 * Waits for the newest code sent to `email`, returns it, and removes the file.
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
    const code = readNewestCode(path);
    if (code) {
      // Delete on read — see the header. `force` because a concurrent reader may have won.
      rmSync(path, { force: true });
      return code;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `outbox: no sign-in code arrived for ${email} within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms. Expected a line in ${path}. The API is booted with EMAIL_TRANSPORT=file and EMAIL_OUTBOX_DIR pointing at this directory; if that is not so, no code can ever appear here.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** The code on the newest line of an outbox file, or undefined if there is nothing readable yet. */
function readNewestCode(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // Not written yet. The ordinary case on the first few polls.
  }

  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index--) {
    // A torn final line from a concurrent append is skipped rather than throwing; the next poll
    // sees it whole.
    let message: { text?: unknown };
    try {
      message = JSON.parse(lines[index] as string);
    } catch {
      continue;
    }
    if (typeof message.text !== "string") continue;
    const found = OTP_PATTERN.exec(message.text);
    if (found?.[1]) return found[1];
  }
  return undefined;
}

/**
 * Removes any code queued for an address without consuming it as a sign-in.
 *
 * Used where a spec has deliberately caused a send it does not intend to use — so a later
 * `waitForOtp` cannot pick up the stale one and report success for the wrong reason.
 */
export function discardOtp(dir: string, email: string): void {
  rmSync(outboxFileFor(dir, email), { force: true });
}
