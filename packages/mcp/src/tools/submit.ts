/**
 * `submit_opportunity` — the only tool that writes, in three phases with a human in the middle.
 *
 * PHASE 0 refuses a credential inside the document before a request exists: the API stores the text
 * it is given, so a key in `description` would be persisted and only then redacted out of the reply.
 * PHASE 1 validates locally, writes a 0600 pending record and returns `status: "pending"` plus a
 * public digest — NO SECRET, because a token returned in the tool's own response is spendable by
 * the same model in the same turn. PHASE 2 happens at a person's terminal, outside this file.
 * PHASE 3 recomputes the five bindings FROM CURRENT STATE, claims the approval by atomic rename
 * BEFORE any network call, and never restores it at any outcome.
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
import { DUPLICATES_NOTICE, SUBMIT_NOTICE, delimit, truncate } from "../untrusted.js";
import type { ToolContext, ToolSuccess } from "./context.js";

export const TOOL_NAME = "submit_opportunity";

/**
 * Third-party text on the write path, bounded like the search projection's. Kept rather than
 * dropped because a bare id and a score cannot answer "is this the same program".
 */
export const DUPLICATE_TITLE_MAX = 140;

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
    idRule: z
      .string()
      .describe("Says which namespace this server derived, and whether the id agrees with it."),
    idMatchesNamespace: z.boolean(),
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
      title: z
        .string()
        .describe(`Third-party text, truncated to ${DUPLICATE_TITLE_MAX} characters.`),
      similarity: z.number().nullable(),
    }),
  ),
  duplicatesNotice: z
    .string()
    .describe("Says that the duplicate titles are third-party text, not instructions."),
  note: z.string(),
});

export const outputSchema = z.discriminatedUnion("status", [pendingSchema, submittedSchema]);

/** Each state said in full, so none of them reads as "no duplicates". */
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
 * NOT schema rules: a conformant document can be over them, so local validation passes and the
 * write fails. Checked at PREVIEW time, or a person approves something that was never admissible.
 * A copy of values that live in the API — if the API loosens a cap this refuses early, which is
 * the safe direction. Source: the write service's field caps and the route's body limit.
 */
export const ADMISSION_CAPS = {
  title: 256,
  summary: 1_000,
  description: 50_000,
  /**
   * TOP-LEVEL arrays only, exactly as the API applies it. Checking more here would refuse a
   * document the API would have accepted, naming a limit nobody enforces.
   */
  arrayEntries: 100,
  /** The route's body limit, applied to the serialized document. */
  bodyBytes: 256 * 1024,
} as const;

/** Deliberately not recursive — see `arrayEntries`. */
function topLevelArrays(document: Record<string, unknown>): { path: string; length: number }[] {
  const out: { path: string; length: number }[] = [];
  for (const [key, value] of Object.entries(document)) {
    if (Array.isArray(value)) out.push({ path: `/${key}`, length: value.length });
  }
  return out;
}

/** Nobody is asked to approve a request that cannot succeed. */
export function assertWithinAdmissionCaps(document: Record<string, unknown>): void {
  const problems: string[] = [];

  for (const field of ["title", "summary", "description"] as const) {
    const value = document[field];
    const cap = ADMISSION_CAPS[field];
    if (typeof value === "string" && value.length > cap) {
      problems.push(`/${field} is ${value.length} characters; the API accepts at most ${cap}.`);
    }
  }

  for (const { path, length } of topLevelArrays(document)) {
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

/** The namespace rule as given: `source.publisher ?? orgs[0].slug`. */
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

/** Phase 0: before validation, before the digest, before anything touches the network. */
export function rejectEmbeddedCredential(document: unknown): void {
  const hits = findSecretPaths(document);
  if (hits.length === 0) return;
  throw new ToolError(
    "invalid_input",
    `The document contains a string shaped like an RFP Hub API key, so nothing was sent. The API stores the text it is given, which means a key in a document would be persisted before anything could redact it. Remove it and revoke that key. Locations: ${hits.join(", ")}`,
    { locations: hits },
  );
}

/** A mismatch is a 400 the caller cannot see coming, so the preview says it before approval. */
export function describeIdRule(facts: DocumentFacts): { text: string; matches: boolean } {
  const prefix = `${facts.namespace}:`;
  const matches =
    facts.namespace !== "" && facts.id.startsWith(prefix) && facts.id.length > prefix.length;
  return {
    matches,
    text: `A public id must be \`<namespace>:<local>\`. This server derives the namespace from the document as \`${facts.namespace || "(none)"}\` (\`source.publisher\`, or \`operatingOrganizations[0].slug\` when that is absent), so the id has to start \`${prefix}\`. The id in this document is \`${facts.id}\`, which ${matches ? "satisfies that rule" : "does NOT satisfy that rule — the API will refuse it"}.`,
  };
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

  // The first four sentences are PRESCRIBED, word for word: dropping `status: "pending"` or
  // softening "must" is the difference between "nothing happened" and "something might have".
  const instruction = `Nothing has been submitted. \`status: "pending"\`. To submit, the person at this machine must run \`rfphub-mcp approve ${approvalId}\` in their own terminal and read what it prints. No approval secret is ever returned here. Then call this tool again with the SAME document and \`approvalId: "${approvalId}"\`. The approval expires ${PENDING_TTL_MS / 60000} minutes after this preview.`;
  const idRule = describeIdRule(facts);

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
      idRule: idRule.text,
      idMatchesNamespace: idRule.matches,
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
    idRule.text,
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

  // ORDER MATTERS. The budget is reserved FIRST because the approval is the expensive resource:
  // running out of daily writes after claiming it would burn a person's attention for nothing.
  const budget = ctx.policy.reserve("commit");

  let claim: ReturnType<typeof claimApproval>;
  try {
    // BEFORE THE NETWORK: claiming after a response would leave the approval spendable again
    // whenever the response never arrives.
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

  // From here the request is going out, so the unit stays spent whatever comes back. A refund on
  // timeout would invite the blind retry the ambiguous-outcome message warns against.
  budget.commit();
  ctx.spentCommitBudget?.();

  const submission = await ctx.api.submitOpportunity(document);
  return renderSubmission(submission);
}

export function renderSubmission(submission: SubmissionResult): ToolSuccess {
  const id = submission.opportunity?.id ?? "(the API returned no id)";
  const duplicates = (submission.duplicates ?? []).map((d) => ({
    id: d.id,
    title: truncate(typeof d.title === "string" ? d.title : "", DUPLICATE_TITLE_MAX),
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
    duplicatesNotice: DUPLICATES_NOTICE,
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
    ...(duplicates.length > 0 ? [DUPLICATES_NOTICE] : []),
    ...duplicates.flatMap((d) => [
      `  - ${d.id} (similarity ${d.similarity ?? "unscored"})`,
      delimit(`title of ${d.id}`, d.title).replace(/^/gm, "    "),
    ]),
    "",
    (submission.warnings ?? []).length
      ? `Advisory warnings:\n${(submission.warnings ?? []).map((w) => `  - ${w}`).join("\n")}`
      : "No advisory warnings.",
  ].join("\n");

  return { text, structured };
}

export { APPROVAL_TTL_MS };
