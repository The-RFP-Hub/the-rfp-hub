/**
 * ONE map from failure to code, for every tool: per-tool vocabularies leave a client unable to tell
 * "not allowed" from "did not parse", since both arrive as prose. No message here carries a
 * credential — the 401/403 branches name the ENV VAR, never the value.
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
  /** Field reports, the diverging digest component, and so on. */
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

/** Repeated wherever a 400 could be about it. */
export const ID_RULE =
  "A public id must be `<namespace>:<local>`, where `<namespace>` is `source.publisher` (or, " +
  "when that is absent, `operatingOrganizations[0].slug`) and must also appear in " +
  "`operatingOrganizations[].slug` — you may only publish under an organization that operates " +
  "the program.";

/** Operations where the caller supplies a public id. */
function mentionsIdRule(operation: string): boolean {
  return operation === "submit_opportunity" || operation === "fetch_opportunity";
}

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

/** Shape-checked rather than trusted: this is a network body. */
export function mergedInto(body: ApiErrorBody | undefined): { id: string; title: string } | null {
  const raw = body?.mergedInto;
  if (raw === null || typeof raw !== "object") return null;
  const { id, title } = raw as { id?: unknown; title?: unknown };
  if (typeof id !== "string" || typeof title !== "string") return null;
  return { id, title };
}

/** A body that did not parse is a DIFFERENT failure from a server error: an HTML 502 from a proxy
 * is not the API answering, so callers pass `body: undefined`. */
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
    // ONLY where the id is the caller's to get right: on a search it explains a field they never
    // sent, and sends them looking in the wrong place.
    const idRule = mentionsIdRule(context.operation) ? `\n${ID_RULE}` : "";
    return new ToolError("invalid_input", `${code ?? "bad_request"}${suffix}${idRule}`, {
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
    // `opportunity_merged` means the id RESOLVED, and the body carries where it went. Reporting
    // that as "not found" sends a caller hunting for a typo in a correct id.
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

/**
 * The write path's scope rule, worded once. `write` alone is what makes a submission wait for a
 * reviewer; `publish` would make an approved one live at once. Names the variable, never the value.
 */
export function keyScopeError(reason: string): ToolError {
  return new ToolError(
    "policy_denied",
    `${reason} Submitting needs a key that carries \`write\` and does not carry \`publish\`. Mint a \`write\`-only key on the deployment's API keys page, put it in RFPHUB_API_KEY in the MCP client's env block, and restart the server. Nothing was validated, previewed or sent, so no approval was spent and the key is never echoed here.`,
    { scopeCheck: true },
  );
}

/** A proxy page, a truncated stream — not the API's JSON envelope. */
export function nonJsonResponseError(status: number, operation: string): ToolError {
  return new ToolError(
    "exec_failed",
    `${operation} returned HTTP ${status} with a body that is not JSON. Something between this server and the API answered instead of the API itself (a proxy, a captive portal, a load balancer error page).`,
    { status, transport: true },
  );
}

/**
 * Every failure once the request has left lands here, and none of them says whether the row was
 * written. The approval stays consumed so the state cannot be resolved by blindly trying again.
 */
export function ambiguousWriteError(
  origin: string,
  what: string,
  cause: unknown,
  advice?: string,
): ToolError {
  return new ToolError(
    "exec_failed",
    `The submission may have landed and its outcome is UNKNOWN: ${what} (${origin}). The entry may or may not have been written. Do NOT resubmit blindly — check GET /v1/me/opportunities first, because the public read hides entries awaiting review. The approval for this submission has been used up either way; if the entry is not there, take a fresh preview and have it approved again.${advice === undefined ? "" : ` ${advice}`}`,
    { ambiguous: true, cause: cause instanceof Error ? cause.message : String(cause) },
  );
}
