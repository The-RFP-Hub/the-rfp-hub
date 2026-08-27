/**
 * ONE map from failure to code, for every tool.
 *
 * Each tool inventing its own vocabulary is how a client ends up unable to tell "you are not
 * allowed to do that" from "that did not parse" — both arrive as prose. A closed set of codes, and
 * a test that asserts nothing outside it is ever emitted, keeps the distinction machine-readable.
 *
 * No message built here ever carries a credential: the API's own error bodies are passed through
 * the redactor before they reach a message, and the 401/403 branches name the ENV VAR, never the
 * value it holds.
 */

export const ERROR_CODES = [
  "tool_not_found",
  "invalid_input",
  "policy_denied",
  "rate_limited",
  "confirmation_required",
  "confirmation_invalid",
  "exec_failed",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ToolError extends Error {
  readonly code: ErrorCode;
  /** Extra machine-readable context (field reports, the diverging digest component, …). */
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** The API's error envelope: `{ error, message }` on every non-2xx it produces itself. */
export interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
  issues?: unknown;
  errors?: unknown;
  /** Present only on an `opportunity_merged` 404: where the entry went. See `mergedInto`. */
  mergedInto?: unknown;
}

/** The `<namespace>:<local>` rule, repeated wherever a 400 could be about it. */
export const ID_RULE =
  "A public id must be `<namespace>:<local>`, where `<namespace>` is `source.publisher` (or, " +
  "when that is absent, `operatingOrganizations[0].slug`) and must also appear in " +
  "`operatingOrganizations[].slug` — you may only publish under an organization that operates " +
  "the program.";

function fieldReport(body: ApiErrorBody): string[] {
  const out: string[] = [];
  const issues = Array.isArray(body.issues) ? body.issues : [];
  for (const issue of issues) {
    if (issue && typeof issue === "object") {
      const rec = issue as Record<string, unknown>;
      const path = typeof rec.path === "string" ? rec.path : "(root)";
      const message = typeof rec.message === "string" ? rec.message : JSON.stringify(rec);
      out.push(`${path}: ${message}`);
    } else if (typeof issue === "string") {
      out.push(issue);
    }
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  for (const e of errors) {
    out.push(typeof e === "string" ? e : JSON.stringify(e));
  }
  return out;
}

/**
 * The `{ id, title }` an `opportunity_merged` 404 points at, or null when the body is any other
 * kind of 404. Shape-checked rather than trusted: this is a network body.
 */
export function mergedInto(body: ApiErrorBody | undefined): { id: string; title: string } | null {
  const raw = body?.mergedInto;
  if (raw === null || typeof raw !== "object") return null;
  const { id, title } = raw as { id?: unknown; title?: unknown };
  if (typeof id !== "string" || typeof title !== "string") return null;
  return { id, title };
}

/**
 * Map one HTTP failure to a `ToolError`.
 *
 * `status` is the HTTP status; `body` is the parsed JSON envelope when there was one. A body that
 * did not parse as JSON is a DIFFERENT failure from a server error — a proxy returning an HTML 502
 * is not the API answering — so callers pass `body: undefined` and get `exec_failed` with that
 * said plainly.
 */
export function apiErrorToToolError(
  status: number,
  body: ApiErrorBody | undefined,
  context: { operation: string; keyConfigured: boolean },
): ToolError {
  const code = typeof body?.error === "string" ? body.error : undefined;
  const message = typeof body?.message === "string" ? body.message : undefined;
  const suffix = message ? ` — ${message}` : "";

  if (status === 400) {
    const fields = fieldReport(body ?? {});
    if (code === "validation_failed" || fields.length > 0) {
      return new ToolError(
        "invalid_input",
        `The API rejected the document as non-conformant${suffix}${fields.length ? `\n${fields.map((f) => `  - ${f}`).join("\n")}` : ""}`,
        { status, apiError: code, fields },
      );
    }
    return new ToolError("invalid_input", `${code ?? "bad_request"}${suffix}\n${ID_RULE}`, {
      status,
      apiError: code,
    });
  }

  if (status === 401) {
    return new ToolError(
      "policy_denied",
      context.keyConfigured
        ? "The API rejected the configured credential (401). Set a valid key in RFPHUB_API_KEY in " +
            "the MCP client's env block and restart the server. The key is never accepted as a tool " +
            "argument and is never echoed back here."
        : "No credential is configured. Set RFPHUB_API_KEY in the MCP client's env block. " +
            "Reads are anonymous and need no key; only submitting does.",
      { status, apiError: code },
    );
  }

  if (status === 403) {
    return new ToolError(
      "policy_denied",
      `The credential lacks the capability this call needs${suffix} Mint a key with the scope the message names. A \`write\`-only key is the recommended one: its submissions land pending for review instead of publishing immediately.`,
      { status, apiError: code },
    );
  }

  if (status === 409) {
    if (code === "pending_limit_reached") {
      return new ToolError(
        "policy_denied",
        `This account already has the maximum of 5 submissions awaiting review. A slot frees up when a reviewer approves or rejects one of them; nothing was written.${suffix}`,
        { status, apiError: code },
      );
    }
    return new ToolError("policy_denied", `${code ?? "conflict"}${suffix}`, {
      status,
      apiError: code,
    });
  }

  if (status === 404) {
    // Two different situations wear the same status, and collapsing them loses a followable
    // pointer. `opportunity_merged` means the id RESOLVED — it named an entry a reviewer merged
    // into another — and the body carries where it went. Reporting that as a bare "not found"
    // sends a caller looking for a typo in an id that was perfectly correct.
    const merged = mergedInto(body);
    if (merged !== null) {
      return new ToolError(
        "invalid_input",
        `That id names an entry that was merged into another during review, so it no longer has its own record. The entry it was merged into is \`${merged.id}\` (${JSON.stringify(merged.title)}). Fetch that id instead.`,
        { status, apiError: code, mergedInto: merged },
      );
    }
    return new ToolError(
      "invalid_input",
      `No published opportunity has that id${suffix} Ids are \`<namespace>:<local>\` and are case-sensitive. An entry still awaiting review is not on the public read surface at all — its submitter finds it through GET /v1/me/opportunities.`,
      { status, apiError: code },
    );
  }

  if (status === 429) {
    return new ToolError(
      "rate_limited",
      `The API is rate limiting this caller${suffix} Wait and retry with a narrower request.`,
      { status, apiError: code },
    );
  }

  if (status >= 500) {
    return new ToolError(
      "exec_failed",
      `The API returned ${status}${suffix} This is a server-side failure, not a problem with the request as sent.`,
      { status, apiError: code },
    );
  }

  return new ToolError(
    "exec_failed",
    `Unexpected HTTP ${status} from ${context.operation}${suffix}`,
    {
      status,
      apiError: code,
    },
  );
}

/** A response whose body was not the API's JSON envelope — a proxy page, a truncated stream. */
export function nonJsonResponseError(status: number, operation: string): ToolError {
  return new ToolError(
    "exec_failed",
    `${operation} returned HTTP ${status} with a body that is not JSON. Something between this server and the API answered instead of the API itself (a proxy, a captive portal, a load balancer error page).`,
    { status, transport: true },
  );
}

/**
 * A write whose outcome is genuinely UNKNOWN.
 *
 * Every failure once the request has left this process lands here: a dropped connection, a body
 * that stops mid-stream, a body that is not JSON, a body over the cap. None of them says anything
 * about whether the row was written, and the one thing a caller must not do is assume. The
 * approval stays consumed — see `approvals.ts` — precisely so this state cannot be resolved by
 * blindly trying again.
 */
export function ambiguousWriteError(origin: string, what: string, cause: unknown): ToolError {
  return new ToolError(
    "exec_failed",
    `The submission may have landed and its outcome is UNKNOWN: ${what} (${origin}). The entry may or may not have been written. Do NOT resubmit blindly — check GET /v1/me/opportunities first, because the public read hides entries awaiting review. The approval for this submission has been used up either way; if the entry is not there, take a fresh preview and have it approved again.`,
    { ambiguous: true, cause: cause instanceof Error ? cause.message : String(cause) },
  );
}
