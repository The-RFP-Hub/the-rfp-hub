/**
 * `submit_opportunity` — the only tool that writes, in three phases with a human in the middle.
 *
 * PHASE 0 — refuse a credential inside the document, before anything else happens. The API accepts
 * free text in `description`, `eligibility` and a dozen other places, so a key pasted into one of
 * them would be PERSISTED and only then redacted out of the reply. Output redaction cannot save
 * that; the document has to be refused before a request exists.
 *
 * PHASE 1 — preview. The document is validated locally with the same implementation the API runs,
 * a public digest is computed over five bindings, a pending record is written 0600, and the caller
 * gets back `status: "pending"` and the digest. NO SECRET IS RETURNED. A confirmation token that
 * comes back in the tool's own response is spendable by the same model in the same turn, which is
 * input-binding, not consent.
 *
 * PHASE 2 — a person runs `rfphub-mcp approve <id>` in a terminal, reads the five bindings and the
 * document that is printed there, and confirms. That happens outside this file and outside the MCP
 * channel. It is NOT isolated from an agent holding a shell as the same user — see `approvals.ts`
 * and ADR 0012 for what is and is not claimed.
 *
 * PHASE 3 — commit. The five bindings are recomputed FROM CURRENT STATE (including which API and
 * which credential are configured right now), the approval is claimed by an atomic rename BEFORE
 * any network call, and only then is the POST made. The approval is never restored, at any
 * outcome: after a timeout the honest state is "may have been written", and a restored approval
 * invites a second write.
 */
import { humanizeIssues, validateOpportunity } from "rfphub-validate";
import { z } from "zod";
import {
  APPROVAL_TTL_MS,
  type ApprovalBinding,
  PENDING_TTL_MS,
  claimApproval,
  computeApprovalId,
  describeBinding,
  diagnoseMismatch,
  documentHashOf,
  fingerprintOf,
  isExpired,
  readApproval,
  writePending,
} from "../approvals.js";
import { ToolError } from "../errors.js";
import type { SubmissionResult } from "../http.js";
import { findSecretPaths } from "../redact.js";
import { SUBMIT_NOTICE, delimit, truncate } from "../untrusted.js";
import type { ToolContext, ToolSuccess } from "./context.js";

export const TOOL_NAME = "submit_opportunity";

export const TOOL_DESCRIPTION =
  "Submit one funding opportunity, as an RFP Hub Standard document, for review and publication. " +
  "This is a two-step tool: the first call validates the document and returns a preview plus an " +
  "approval id, and writes nothing. A person at this machine then approves that id in their own " +
  "terminal. A second call with the same document and that approval id performs the submission. " +
  "Submissions from a review-scoped credential land pending a human decision.";

export const inputSchema = z.strictObject({
  document: z
    .record(z.string(), z.unknown())
    .describe("The complete opportunity, as an RFP Hub Standard document."),
  approvalId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional()
    .describe(
      "The approval id from a previous preview of this exact document. Omit it to get a preview.",
    ),
});

export type SubmitInput = z.infer<typeof inputSchema>;

const pendingSchema = z.object({
  status: z.literal("pending"),
  approvalId: z.string(),
  preview: z.object({
    namespace: z.string(),
    id: z.string(),
    title: z.string(),
    fundingType: z.string(),
    entryStatus: z.string(),
    organizations: z.array(z.string()),
    awardFields: z.record(z.string(), z.union([z.string(), z.number()])),
    deadlineCount: z.number(),
    validatorWarnings: z.array(z.string()),
    destination: z.string(),
    credentialFingerprint: z.string(),
  }),
  instruction: z.string(),
});

const submittedSchema = z.object({
  status: z.literal("submitted"),
  id: z.string().describe("Promoted here from `opportunity.id` in the API's reply."),
  created: z.boolean(),
  reviewStatus: z.string(),
  isListed: z.boolean(),
  warnings: z.array(z.string()),
  duplicateCheck: z.enum(["ok", "unavailable", "disabled"]),
  duplicateCheckExplanation: z.string(),
  duplicates: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      similarity: z.number().nullable(),
    }),
  ),
  note: z.string(),
});

export const outputSchema = z.discriminatedUnion("status", [pendingSchema, submittedSchema]);

/** The three states of `duplicateCheck`, each said in full so none reads as "no duplicates". */
export function explainDuplicateCheck(
  status: SubmissionResult["duplicateCheck"],
  found: number,
): string {
  switch (status) {
    case "ok":
      return found === 0
        ? "The duplicate check RAN and found nothing similar among publicly visible entries."
        : `The duplicate check RAN and flagged ${found} publicly visible entr${found === 1 ? "y" : "ies"} as similar. Similar is not identical — read them before assuming this is a repeat.`;
    case "unavailable":
      return (
        "The duplicate check DID NOT RUN: the similarity service failed or timed out. This is NOT " +
        "the same as 'no duplicates' — nothing was compared. A background job still owes this " +
        "entry a check."
      );
    case "disabled":
      return (
        "The duplicate check DID NOT RUN: this deployment has no similarity provider configured. " +
        "This is NOT the same as 'no duplicates' — nothing was compared."
      );
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled duplicateCheck: ${String(unhandled)}`);
    }
  }
}

/**
 * The API's admission limits, mirrored here so a preview refuses what the submission would.
 *
 * These are NOT schema rules — a document can be perfectly conformant and still be over them, so
 * local validation passes and the write fails. Checking them only at commit time would mean a
 * person reads a document, approves it, and only then finds out it was never admissible: their
 * approval is spent, the round trip is wasted, and the failure arrives at the point where it is
 * most expensive.
 *
 * They are a COPY of values that live in the API, which is a real cost: if the API loosens a cap,
 * this refuses something that would now be accepted. That is the safe direction, and it is why the
 * numbers are stated here with their source rather than buried as literals. Source: the write
 * service's field caps and the submission route's body limit.
 */
export const ADMISSION_CAPS = {
  title: 256,
  summary: 1_000,
  description: 50_000,
  /** Any array anywhere in the document, top level or nested. */
  arrayEntries: 100,
  /** The route's body limit, applied to the serialized document. */
  bodyBytes: 256 * 1024,
} as const;

/** Every array in the document, with the path that reaches it. */
function arrayPaths(value: unknown, at: string, out: { path: string; length: number }[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    out.push({ path: at || "(root)", length: value.length });
    value.forEach((item, i) => arrayPaths(item, `${at}[${i}]`, out));
    return;
  }
  for (const [key, item] of Object.entries(value)) arrayPaths(item, `${at}/${key}`, out);
}

/**
 * Refuse, at PREVIEW time, anything the API would refuse on admission. Nothing is sent either way;
 * the point is that nobody is asked to approve a request that cannot succeed.
 */
export function assertWithinAdmissionCaps(document: Record<string, unknown>): void {
  const problems: string[] = [];

  for (const field of ["title", "summary", "description"] as const) {
    const value = document[field];
    const cap = ADMISSION_CAPS[field];
    if (typeof value === "string" && value.length > cap) {
      problems.push(`/${field} is ${value.length} characters; the API accepts at most ${cap}.`);
    }
  }

  const arrays: { path: string; length: number }[] = [];
  arrayPaths(document, "", arrays);
  for (const { path, length } of arrays) {
    if (length > ADMISSION_CAPS.arrayEntries) {
      problems.push(
        `${path} has ${length} entries; the API accepts at most ${ADMISSION_CAPS.arrayEntries}.`,
      );
    }
  }

  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  } catch {
    bytes = Number.POSITIVE_INFINITY;
  }
  if (bytes > ADMISSION_CAPS.bodyBytes) {
    problems.push(
      `the serialized document is ${bytes} bytes; the API's submission route accepts at most ${ADMISSION_CAPS.bodyBytes}.`,
    );
  }

  if (problems.length > 0) {
    throw new ToolError(
      "invalid_input",
      `The document is schema-conformant but over the limits the API admits, so nothing was sent and no approval was created:\n${problems.map((entry) => `  - ${entry}`).join("\n")}`,
      { problems },
    );
  }
}

interface DocumentFacts {
  namespace: string;
  id: string;
  title: string;
  fundingType: string;
  entryStatus: string;
  organizations: string[];
  awardFields: Record<string, string | number>;
  deadlineCount: number;
}

/** The namespace rule, applied to the document as given: `source.publisher ?? orgs[0].slug`. */
export function deriveFacts(document: Record<string, unknown>): DocumentFacts {
  const source = asRecord(document.source);
  const orgs = Array.isArray(document.operatingOrganizations)
    ? document.operatingOrganizations.map(asRecord)
    : [];
  const firstSlug = typeof orgs[0]?.slug === "string" ? (orgs[0].slug as string) : "";
  const publisher = typeof source?.publisher === "string" ? source.publisher : undefined;
  const funding = asRecord(document.fundingInfo);
  const awardFields: Record<string, string | number> = {};
  for (const key of ["currency", "budget", "minAward", "maxAward", "allocated"] as const) {
    const value = funding?.[key];
    if (typeof value === "string" || typeof value === "number") awardFields[key] = value;
  }
  return {
    namespace: publisher ?? firstSlug,
    id: typeof document.id === "string" ? document.id : "(no id)",
    title: typeof document.title === "string" ? truncate(document.title, 200) : "(no title)",
    fundingType: typeof document.fundingType === "string" ? document.fundingType : "(none)",
    entryStatus: typeof document.status === "string" ? document.status : "(none)",
    organizations: orgs
      .map((org) => (typeof org?.slug === "string" ? org.slug : null))
      .filter((slug): slug is string => slug !== null),
    awardFields,
    deadlineCount: Array.isArray(document.deadlines) ? document.deadlines.length : 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Phase 0. Runs before validation, before the digest, before anything touches the network. */
export function rejectEmbeddedCredential(document: unknown): void {
  const hits = findSecretPaths(document);
  if (hits.length === 0) return;
  throw new ToolError(
    "invalid_input",
    `The document contains a string shaped like an RFP Hub API key, so nothing was sent. The API stores the text it is given, which means a key in a document would be persisted before anything could redact it. Remove it and revoke that key. Locations: ${hits.join(", ")}`,
    { locations: hits },
  );
}

function bindingFor(document: Record<string, unknown>, ctx: ToolContext): ApprovalBinding {
  return {
    apiOrigin: ctx.config.apiOrigin,
    keyFingerprint: fingerprintOf(ctx.config.apiKey),
    operation: "submit_opportunity",
    protocolVersion: ctx.protocolVersion,
    documentHash: documentHashOf(document),
  };
}

export async function run(input: SubmitInput, ctx: ToolContext): Promise<ToolSuccess> {
  // ── phase 0 ────────────────────────────────────────────────────────────────
  rejectEmbeddedCredential(input.document);

  if (ctx.config.apiKey === null) {
    throw new ToolError(
      "policy_denied",
      "Submitting needs a credential, and none is configured. Set RFPHUB_API_KEY in the MCP " +
        "client's env block and restart the server. It is never accepted as a tool argument. " +
        "Refusing here rather than at the end means no one is asked to approve a submission that " +
        "cannot succeed.",
    );
  }

  // ── phase 1 ────────────────────────────────────────────────────────────────
  const result = validateOpportunity(input.document);
  if (!result.valid) {
    const issues = humanizeIssues(result.errors, input.document);
    throw new ToolError(
      "invalid_input",
      `The document does not conform to the RFP Hub Standard, so nothing was sent:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`,
      { issues },
    );
  }
  const validatorWarnings = result.warnings.map((w) => `${w.code}: ${w.message}`);
  assertWithinAdmissionCaps(input.document);

  const binding = bindingFor(input.document, ctx);
  const approvalId = computeApprovalId(binding);
  const facts = deriveFacts(input.document);

  if (input.approvalId === undefined) {
    return preview(input.document, binding, approvalId, facts, validatorWarnings, ctx);
  }

  // ── phase 3 ────────────────────────────────────────────────────────────────
  return commit(input.document, input.approvalId, binding, approvalId, ctx);
}

function preview(
  document: Record<string, unknown>,
  binding: ApprovalBinding,
  approvalId: string,
  facts: DocumentFacts,
  validatorWarnings: string[],
  ctx: ToolContext,
): ToolSuccess {
  ctx.policy.consume("preview");
  const now = ctx.now();
  writePending(ctx.config.home, {
    ...binding,
    approvalId,
    document,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
  });

  const instruction = `Nothing has been submitted. To submit, the person at this machine must run \`rfphub-mcp approve ${approvalId}\` in their own terminal and read what it prints. No approval secret is ever returned here. Then call this tool again with the SAME document and \`approvalId: "${approvalId}"\`. The approval expires ${PENDING_TTL_MS / 60000} minutes after this preview.`;

  const structured = {
    status: "pending" as const,
    approvalId,
    preview: {
      namespace: facts.namespace,
      id: facts.id,
      title: facts.title,
      fundingType: facts.fundingType,
      entryStatus: facts.entryStatus,
      organizations: facts.organizations,
      awardFields: facts.awardFields,
      deadlineCount: facts.deadlineCount,
      validatorWarnings,
      destination: binding.apiOrigin,
      credentialFingerprint: binding.keyFingerprint,
    },
    instruction,
  };

  const text = [
    SUBMIT_NOTICE,
    "",
    "Would be submitted:",
    `  id            : ${facts.id}`,
    `  namespace     : ${facts.namespace}`,
    `  funding type  : ${facts.fundingType}`,
    `  status        : ${facts.entryStatus}`,
    `  organizations : ${facts.organizations.join(", ") || "(none)"}`,
    `  deadlines     : ${facts.deadlineCount}`,
    ...Object.entries(facts.awardFields).map(([k, v]) => `  ${k.padEnd(14)}: ${v}`),
    delimit("title as supplied", facts.title),
    "",
    validatorWarnings.length
      ? `Advisory warnings (not fatal):\n${validatorWarnings.map((w) => `  - ${w}`).join("\n")}`
      : "No advisory warnings.",
    "",
    describeBinding(binding),
    "",
    instruction,
  ].join("\n");

  return { text, structured };
}

async function commit(
  document: Record<string, unknown>,
  claimedId: string,
  binding: ApprovalBinding,
  approvalId: string,
  ctx: ToolContext,
): Promise<ToolSuccess> {
  if (claimedId !== approvalId) {
    const divergence = diagnoseMismatch(ctx.config.home, binding);
    const detail = divergence
      ? `The \`${divergence.component}\` bound into that approval was ` +
        `\`${divergence.expected}\`; it is now \`${divergence.actual}\`.`
      : "The document itself differs from the one that was previewed — no stored approval shares " +
        "its hash.";
    throw new ToolError(
      "confirmation_invalid",
      `That approval id does not match this request, so nothing was sent. ${detail} An approval binds the destination, the credential, the operation, the protocol revision and the document together, precisely so an approval granted for one of them cannot be spent on another. Preview again to get an approval for what you actually want to send.`,
      divergence ? { component: divergence.component } : {},
    );
  }

  const granted = readApproval(ctx.config.home, approvalId);
  if (granted === null) {
    throw new ToolError(
      "confirmation_required",
      `This document has been previewed but not approved, so nothing was sent. The person at this machine must run \`rfphub-mcp approve ${approvalId}\` in their own terminal, read the destination, credential fingerprint and document it prints, and confirm. Then call this tool again unchanged.`,
      { approvalId },
    );
  }
  if (isExpired(granted, ctx.now())) {
    throw new ToolError(
      "confirmation_invalid",
      `That approval expired at ${granted.expiresAt}, so nothing was sent. Approvals are short-lived on purpose. Preview again and have it approved afresh.`,
      { approvalId, expiresAt: granted.expiresAt },
    );
  }

  // ORDER MATTERS HERE, AND THIS IS THE ORDER.
  //
  // The write budget is reserved FIRST, because it is the cheap resource and the approval is the
  // expensive one: a person spent attention on the approval, and running out of daily writes after
  // the approval has been claimed would burn it for nothing — the caller would have to go back and
  // ask them again for a submission that never left. Reserving first means a purely local refusal
  // costs nothing.
  const budget = ctx.policy.reserve("commit");

  let claim: ReturnType<typeof claimApproval>;
  try {
    // THE CLAIM HAPPENS BEFORE THE NETWORK. An atomic rename means two processes racing this
    // approval produce exactly one winner; claiming after a successful response would leave the
    // approval spendable again whenever the response never arrives.
    claim = claimApproval(ctx.config.home, approvalId);
  } catch (err) {
    budget.release();
    throw err;
  }
  if (claim === null) {
    // Another process won the race. Nothing was sent, so the reservation goes back.
    budget.release();
    throw new ToolError(
      "confirmation_invalid",
      "That approval was already used and nothing was sent. An approval is single-use: either this submission already ran, or another process claimed it first. Check `GET /v1/me/opportunities` before submitting again — the public read hides entries awaiting review.",
      { approvalId },
    );
  }

  // From this line on the request is going out, so the unit stays spent whatever comes back —
  // including nothing at all. A timeout that refunded the budget would invite exactly the blind
  // retry the ambiguous-outcome message tells the caller not to make.
  budget.commit();
  ctx.spentCommitBudget?.();

  const submission = await ctx.api.submitOpportunity(document);
  return renderSubmission(submission);
}

export function renderSubmission(submission: SubmissionResult): ToolSuccess {
  const id = submission.opportunity?.id ?? "(the API returned no id)";
  const duplicates = (submission.duplicates ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    similarity: d.similarity ?? null,
  }));
  const duplicateCheckExplanation = explainDuplicateCheck(
    submission.duplicateCheck,
    duplicates.length,
  );
  const structured = {
    status: "submitted" as const,
    id,
    created: submission.created,
    reviewStatus: submission.reviewStatus,
    isListed: submission.isListed,
    warnings: submission.warnings ?? [],
    duplicateCheck: submission.duplicateCheck,
    duplicateCheckExplanation,
    duplicates,
    note:
      "`id` is promoted here from `opportunity.id` in the API's reply; the API's own result " +
      "object has no top-level id field.",
  };

  const listing = submission.isListed
    ? "It is listed on the public site."
    : "It is NOT on the public site yet — an entry awaiting review is visible only through " +
      "`GET /v1/me/opportunities`.";

  const text = [
    `Submitted. id: ${id}`,
    `  ${submission.created ? "Created a new entry." : "Replaced an existing entry."}`,
    `  Review status: ${submission.reviewStatus}. ${listing}`,
    "",
    duplicateCheckExplanation,
    ...duplicates.map((d) => `  - ${d.id} (similarity ${d.similarity ?? "unscored"})`),
    "",
    (submission.warnings ?? []).length
      ? `Advisory warnings:\n${(submission.warnings ?? []).map((w) => `  - ${w}`).join("\n")}`
      : "No advisory warnings.",
  ].join("\n");

  return { text, structured };
}

export { APPROVAL_TTL_MS };
