/**
 * The write path: one Standard document in, one audited row out — and every attribution field set
 * by the SERVER.
 *
 * Order of operations, and why it is this order:
 *
 *   1. **Shape and size caps** before anything else. A 50 000-character description costs nothing
 *      to reject and a lot to validate, store and diff.
 *   2. **`validateOpportunity(body, {checks:true})` is the sole validator.** The submissions plugin
 *      installs a pass-through Fastify validator (D-7) precisely so this runs instead of ajv
 *      rejecting the body first with its own generic message; the humanized errors are the whole
 *      point of the endpoint being usable. Advisory `warnings` are returned with a 201, never fatal.
 *   3. **Namespace, then id.** `namespace = source.publisher ?? operatingOrganizations[0].slug`, and
 *      the public id must be `<namespace>:<local>` — the same derivation `source_system` uses, so an
 *      entry cannot be filed under a system it was not authorized for.
 *   4. **Capabilities against that namespace**, from `effectiveCaps`. Never re-derived here.
 *   5. **Provenance is overwritten, wholesale.** The mapper persists `submittedBy`, `submittedAt`
 *      and `originalId` straight from the body, so leaving any of them client-controlled permits
 *      attribution impersonation, forged submission times, and deliberate collisions against the
 *      `ux_opp_source` unique key. Every one of them is server-set below; `originalId` is accepted
 *      only from a credential that could publish here, because it is half of that unique key.
 *   6. **Organizations are INSERT … ON CONFLICT DO NOTHING.** Never the read path's
 *      `upsertOrganization`, whose `onConflictDoUpdate` rewrites name, website, logo, banner, social
 *      links, ecosystems and contacts — reusing it here would let any submitter overwrite a
 *      verified organization's branding by naming its slug (D-9).
 *   7. **The mutation and its audit row share one transaction**, so history and state commit
 *      together or not at all.
 *
 * IDEMPOTENCY WITHOUT A KEY TABLE. A `POST` whose id already exists is compared field by field
 * against the stored row through the same normalized projection that produced it. Byte-identical and
 * from the original submitter → the original result, as a 200: a retried create succeeds instead of
 * punishing a flaky network. Anything else → 409.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { eq } from "drizzle-orm";
import { humanizeErrors, validateOpportunity } from "rfphub-validate";
import { type DB, type Tx, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityInsert,
  type OpportunityRow,
  opportunities,
  organizations,
} from "../../../db/schema.js";
import { fromStandard, organizationInserts, toStandard } from "../../mappers/opportunity.mapper.js";
import { type Capabilities, type Principal, effectiveCaps } from "../../shared/capabilities.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import { checkPublicId, resolveNamespace } from "../../shared/namespace.js";
import { diffFields } from "../../shared/patch.js";
import { AuditService } from "../audit/audit.service.js";
import { violatedConstraint } from "../auth/account.service.js";
import type { RequestPrincipal } from "../auth/principal.service.js";

/** Per-field caps, enforced before anything is persisted. The body cap is on the route. */
export const FIELD_CAPS = {
  title: 256,
  summary: 1_000,
  description: 50_000,
  /** Any top-level array, and any organization array. */
  arrayEntries: 100,
} as const;

/**
 * The seam Wave 3 fills.
 *
 * Duplicate detection and source verification both want to run AFTER the row is committed and
 * OUTSIDE the transaction — an embedding call that fails must not roll back a legitimate
 * submission, and a source fetch must never hold a database transaction open across the network.
 * So the write path commits, then calls this, and a hook that throws is logged and swallowed by the
 * caller rather than turning a stored entry into a 500.
 */
export interface WriteHooks {
  afterCommit?(event: AfterCommitEvent): Promise<void> | void;
}

export interface AfterCommitEvent {
  opportunityId: number;
  publicId: string;
  namespace: string;
  created: boolean;
  principal: Principal;
}

export interface WriteResult {
  /** The stored record as the Standard object it is. */
  opportunity: Opportunity;
  created: boolean;
  reviewStatus: "pending" | "approved" | "rejected";
  isListed: boolean;
  /** Advisory check-tier findings. Never fatal; a 201 carries them so a publisher can act. */
  warnings: string[];
  /** True when an identical repeat of an earlier create was recognised and no row changed. */
  repeated: boolean;
  row: OpportunityRow;
}

export interface WriteOptions {
  /** `PUT` supplies the path id; `body.id` must equal it. */
  pathId?: string;
  /** `PUT` refuses to create; `POST` refuses to silently overwrite. */
  mode: "create" | "replace";
}

export class OpportunityWriteService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: DB = defaultDb,
    private readonly hooks: WriteHooks = {},
  ) {
    this.audit = new AuditService(db);
  }

  async write(
    principal: RequestPrincipal,
    body: unknown,
    options: WriteOptions,
  ): Promise<WriteResult> {
    const record = asDocument(body);
    assertWithinCaps(record);

    const { valid, errors, warnings } = validateOpportunity(record, { checks: true });
    if (!valid) {
      throw new HttpError(
        400,
        "validation_failed",
        "the submission is not a valid RFP Hub Standard opportunity.",
        { errors: humanizeErrors(errors, record) },
      );
    }
    const document = record as unknown as Opportunity;

    const namespace = resolveNamespace(document);
    if (namespace === undefined) {
      throw badRequest(
        "namespace_required",
        "a submission must name the namespace it is published under: set `source.publisher` to an organisation slug, or give `operatingOrganizations[0].slug`.",
      );
    }
    const idProblem = checkPublicId(document.id, namespace);
    if (idProblem) throw badRequest("invalid_id", idProblem);

    if (options.mode === "replace" && options.pathId !== undefined) {
      if (document.id !== options.pathId) {
        throw badRequest(
          "id_immutable",
          `\`id\` is immutable: the body says ${JSON.stringify(document.id)} and the path says ${JSON.stringify(options.pathId)}.`,
        );
      }
    }

    const caps = effectiveCaps(principal, namespace);
    if (!caps.canSubmit) {
      throw forbidden(
        "missing_scope",
        "writing requires the `write` scope (or the stronger `publish`) on an API key.",
      );
    }

    const existing = await this.findByPublicId(document.id);
    const now = new Date();
    const attributed = this.applyProvenance(document, {
      principal,
      caps,
      namespace,
      now,
      existing,
    });

    if (options.mode === "create" && existing) {
      // An identical repeat by the ORIGINAL submitter succeeds; anything else — including a
      // different account reaching for an id that is taken — is one undifferentiated 409. A 403
      // here would confirm to a stranger that the id exists and who it belongs to.
      const repeat = this.identicalRepeat(principal, attributed, existing);
      if (repeat) return repeat;
      throw conflict(
        "id_conflict",
        `an opportunity with id ${JSON.stringify(document.id)} already exists and differs from this submission. Use PUT to replace it.`,
      );
    }

    if (options.mode === "replace") {
      if (!existing) throw notFound(`no opportunity ${JSON.stringify(document.id)}.`);
      if (!mayWriteExisting(principal, caps, existing, namespace)) {
        throw forbidden(
          "not_your_entry",
          "that entry was submitted by another account and you are not a verified publisher of its namespace.",
        );
      }
    }

    return this.persist({
      principal,
      caps,
      namespace,
      document: attributed,
      existing,
      now,
      warnings: warnings.map((warning) => warning.message),
    });
  }

  private async findByPublicId(publicId: string): Promise<OpportunityRow | undefined> {
    const rows = await this.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.publicId, publicId))
      .limit(1);
    return rows[0];
  }

  /**
   * Every attribution field, set by the server.
   *
   * `submittedBy` is the publishing organization's slug when the account holds a verified
   * membership on the namespace (the entry is the ORGANISATION's), else the account's public handle,
   * else `"community"` — never a string from the body.
   */
  private applyProvenance(
    document: Opportunity,
    ctx: {
      principal: RequestPrincipal;
      caps: Capabilities;
      namespace: string;
      now: Date;
      existing: OpportunityRow | undefined;
    },
  ): Opportunity {
    const { principal, caps, namespace, now, existing } = ctx;
    const publishingAsOrg = principal.memberships.some((m) => m.slug === namespace && m.verified);
    const submittedBy = publishingAsOrg ? namespace : (principal.account.handle ?? "community");

    return {
      ...document,
      source: {
        ...(document.source ?? {}),
        publisher: namespace,
        submittedBy,
        // Preserved across an update: when the entry first arrived is a fact about the entry, not
        // about the most recent edit.
        submittedAt: (existing?.sourceSubmittedAt ?? now).toISOString(),
        ingestedVia: principal.credentialKind === "api_key" ? "publisher_api" : "submission",
        // Half of `ux_opp_source`. An arbitrary submitter must not be able to write it, or they
        // could deliberately collide with a publisher's own cross-system key.
        originalId: caps.canPublishImmediately
          ? (document.source?.originalId ?? existing?.originalId ?? undefined)
          : (existing?.originalId ?? undefined),
        // Verification is the verifier's to set, never the submitter's.
        verifiedAgainstSource: existing?.verifiedAgainstSource ?? null,
        verifiedAt: existing?.verifiedAt?.toISOString(),
        snapshotUrl: existing?.snapshotUrl ?? undefined,
      },
      createdAt: existing?.createdAt?.toISOString(),
      updatedAt: now.toISOString(),
    } as Opportunity;
  }

  /**
   * An identical repeat of a create by the original submitter → the original result.
   *
   * Compared through the same normalized projection that produced the row, with the server-owned
   * timestamps excluded, so "identical" means identical as STORED rather than identical as typed.
   */
  private identicalRepeat(
    principal: RequestPrincipal,
    document: Opportunity,
    existing: OpportunityRow,
  ): WriteResult | undefined {
    if (existing.submittedBy !== null && existing.submittedBy !== principal.accountId) {
      return undefined;
    }
    const { opp } = fromStandard(document);
    const candidate = comparable(opp);
    const stored = comparable(existing);
    if (Object.keys(diffFields(stored, candidate)).length > 0) return undefined;
    return {
      opportunity: toStandard(existing),
      created: true,
      reviewStatus: existing.reviewStatus,
      isListed: existing.isListed,
      warnings: [],
      repeated: true,
      row: existing,
    };
  }

  private async persist(ctx: {
    principal: RequestPrincipal;
    caps: Capabilities;
    namespace: string;
    document: Opportunity;
    existing: OpportunityRow | undefined;
    now: Date;
    warnings: string[];
  }): Promise<WriteResult> {
    const { principal, caps, namespace, document, existing, now } = ctx;
    const { opp } = fromStandard(document, now);
    const autoApprove = caps.canPublishImmediately;

    const values: OpportunityInsert = {
      ...opp,
      sourceSystem: namespace,
      reviewStatus: autoApprove ? "approved" : (existing?.reviewStatus ?? "pending"),
      isListed: existing?.isListed ?? true,
      submittedBy: existing?.submittedBy ?? principal.accountId,
      approvedBy: autoApprove
        ? (existing?.approvedBy ?? principal.accountId)
        : existing?.approvedBy,
      approvedAt: autoApprove ? (existing?.approvedAt ?? now) : existing?.approvedAt,
      // A publisher asserting the entry is exactly the "still real" signal the staleness job reads.
      lastSeenAt: now,
      updatedAt: now,
    };

    const created = existing === undefined;

    const row = await this.db
      .transaction(async (tx) => {
        await insertOrganizationStubs(tx, document);

        const written =
          existing === undefined
            ? await tx.insert(opportunities).values(values).returning()
            : await tx
                .update(opportunities)
                .set(values)
                .where(eq(opportunities.id, existing.id))
                .returning();
        const stored = written[0];
        if (!stored) throw new Error(`failed to persist ${document.id}`);

        const patch = diffFields(
          existing ? (comparable(existing) as Record<string, unknown>) : {},
          comparable(stored) as Record<string, unknown>,
        );
        await this.audit.record(tx, {
          subjectKind: "opportunity",
          subjectId: stored.id,
          actorKind: principal.credentialKind === "api_key" ? "api_key" : "user",
          actorAccountId: principal.accountId,
          actorApiKeyId: principal.apiKeyId ?? null,
          action: created ? "create" : "update",
          patch,
        });
        // An auto-approval is a second, separate decision and gets its own row: "created" and
        // "published without review" are different facts and a reader must be able to see both.
        if (autoApprove && existing?.reviewStatus !== "approved") {
          await this.audit.record(tx, {
            subjectKind: "opportunity",
            subjectId: stored.id,
            actorKind: principal.credentialKind === "api_key" ? "api_key" : "user",
            actorAccountId: principal.accountId,
            actorApiKeyId: principal.apiKeyId ?? null,
            action: "approve",
            patch: {
              reviewStatus: { before: existing?.reviewStatus ?? null, after: "approved" },
              reason: "verified_publisher_namespace",
            },
          });
        }
        return stored;
      })
      .catch((error: unknown) => {
        throw translateWriteFailure(error, document);
      });

    await this.runAfterCommit({
      opportunityId: row.id,
      publicId: row.publicId,
      namespace,
      created,
      principal,
    });

    return {
      opportunity: toStandard(row),
      created,
      reviewStatus: row.reviewStatus,
      isListed: row.isListed,
      warnings: ctx.warnings,
      repeated: false,
      row,
    };
  }

  /** Wave 3's seam. A hook failure is never allowed to un-store a stored entry. */
  private async runAfterCommit(event: AfterCommitEvent): Promise<void> {
    if (!this.hooks.afterCommit) return;
    try {
      await this.hooks.afterCommit(event);
    } catch {
      // Deliberately swallowed: the row is committed and public behaviour must not depend on a
      // post-commit enrichment succeeding. The hook owns its own logging and retry (a backfill job).
    }
  }
}

/**
 * Directory stubs for organizations this entry names — created, never updated.
 *
 * This is the whole of D-9 in three lines: a slug nobody knows becomes a stub, and a slug that is
 * already a verified publisher keeps every field it has.
 */
export async function insertOrganizationStubs(tx: Tx, document: Opportunity): Promise<void> {
  const orgs = organizationInserts(document);
  if (orgs.length === 0) return;
  await tx.insert(organizations).values(orgs).onConflictDoNothing({ target: organizations.slug });
}

/** The document, as an object, or a 400 that says what arrived instead. */
function asDocument(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest(
      "invalid_body",
      "the request body must be a single RFP Hub Standard opportunity object.",
    );
  }
  return body as Record<string, unknown>;
}

/** Field caps, checked before validation so an oversized body is cheap to refuse. */
export function assertWithinCaps(record: Record<string, unknown>): void {
  const problems: string[] = [];
  for (const [field, cap] of [
    ["title", FIELD_CAPS.title],
    ["summary", FIELD_CAPS.summary],
    ["description", FIELD_CAPS.description],
  ] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > cap) {
      problems.push(`\`${field}\` must be at most ${cap} characters (got ${value.length}).`);
    }
  }
  for (const [field, value] of Object.entries(record)) {
    if (Array.isArray(value) && value.length > FIELD_CAPS.arrayEntries) {
      problems.push(
        `\`${field}\` must have at most ${FIELD_CAPS.arrayEntries} entries (got ${value.length}).`,
      );
    }
  }
  if (problems.length > 0) {
    throw new HttpError(400, "validation_failed", "the submission exceeds the size limits.", {
      errors: problems,
    });
  }
}

/**
 * Whether this principal may write over an entry that already exists.
 *
 * Either they submitted it, or they are a verified publisher of the namespace it is filed under —
 * which is what a granted claim transfers. A reviewer role deliberately does not appear: editing an
 * entry is a review action with its own audited route.
 */
function mayWriteExisting(
  principal: Principal,
  caps: Capabilities,
  existing: OpportunityRow,
  namespace: string,
): boolean {
  if (existing.submittedBy === principal.accountId) return true;
  if (existing.sourcePublisher !== null && existing.sourcePublisher !== namespace) return false;
  return principal.memberships.some((m) => m.slug === namespace && m.verified) || caps.canAdmin;
}

/** The comparable projection of a row or an insert: content only, no server-owned bookkeeping. */
const NON_CONTENT = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "reviewStatus",
  "isListed",
  "submittedBy",
  "approvedBy",
  "approvedAt",
  "lastSeenAt",
  "mergedIntoId",
  "sourceSubmittedAt",
  "verifiedAgainstSource",
  "verifiedAt",
  "snapshotUrl",
  "nextDeadlineAt",
  "sourceSystem",
]);

function comparable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (NON_CONTENT.has(key)) continue;
    out[key] = value === undefined ? null : value;
  }
  return out;
}

/**
 * BOTH unique violations, told apart by the constraint that fired.
 *
 * `ux_opp_source` is the cross-system key `(source_system, original_id)`; colliding on it is a
 * different problem from colliding on the public id, and answering "id conflict" for it sends the
 * caller to change the wrong field.
 */
function translateWriteFailure(error: unknown, document: Opportunity): unknown {
  const constraint = violatedConstraint(error);
  if (constraint === "ux_opp_source") {
    return conflict(
      "source_key_conflict",
      `another entry already carries the source key (${JSON.stringify(document.source?.publisher ?? null)}, ${JSON.stringify(document.source?.originalId ?? null)}).`,
      {
        conflict: {
          sourceSystem: document.source?.publisher ?? null,
          originalId: document.source?.originalId ?? null,
        },
      },
    );
  }
  if (constraint?.includes("public_id")) {
    return conflict(
      "id_conflict",
      `an opportunity with id ${JSON.stringify(document.id)} already exists.`,
    );
  }
  return error;
}
