import type { VerificationRun } from "./types";

export const BOT_PROTECTION_NOTE =
  "Sites behind bot protection may block this check even when the page exists for human visitors.";

export interface VerificationPresentation {
  response: string;
  /** Null means the automated response cannot establish whether a human-facing page exists. */
  pageExists: boolean | null;
  uncertain: boolean;
}

/**
 * Present the automated response without turning an anti-bot response into evidence of absence.
 * The stored verification verdict stays untouched; this only decides what the reviewer is told.
 */
export function verificationPresentation(run: VerificationRun): VerificationPresentation {
  const status = run.httpStatus;
  const challenge = run.extracted?.automatedCheckBlocked === true;
  const blocked = status === 403 || status === 404 || challenge;

  if (blocked) {
    return {
      response: `Site refused or blocked the automated check${httpStatus(status)}.`,
      pageExists: null,
      uncertain: true,
    };
  }
  if (run.error && status === null) {
    return {
      response: "Network check failed before an HTTP response.",
      pageExists: null,
      uncertain: true,
    };
  }
  if (run.error) {
    return {
      response: `Automated check failed${httpStatus(status)}.`,
      pageExists: null,
      uncertain: true,
    };
  }
  if (status !== null && (status < 200 || status >= 300)) {
    return {
      response: `Site could not be verified${httpStatus(status)}.`,
      pageExists: null,
      uncertain: true,
    };
  }
  if (run.existsAtSource === true) {
    return {
      response: `Page found${httpStatus(status)}.`,
      pageExists: true,
      uncertain: false,
    };
  }
  if (run.existsAtSource === false) {
    return {
      response: `Page appears unavailable${httpStatus(status)}.`,
      pageExists: false,
      uncertain: false,
    };
  }
  return {
    response:
      status === null ? "No HTTP response was recorded." : `No result${httpStatus(status)}.`,
    pageExists: null,
    uncertain: true,
  };
}

function httpStatus(status: number | null): string {
  return status === null ? "" : ` (HTTP ${status})`;
}
