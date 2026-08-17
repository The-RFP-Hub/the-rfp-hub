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
 *   3. **Namespace, then id — and the two questions differ by mode.** On a CREATE the namespace is
 *      `source.publisher ?? operatingOrganizations[0].slug`, it MUST appear among
 *      `operatingOrganizations` (you may only publish under an org that operates the programme —
 *      sponsorship does not authorise it), and the public id must be `<namespace>:<local>`, the
 *      same derivation `source_system` uses, so an entry cannot be filed under a system it was not
 *      authorized for. On a REPLACE the row's stored `source_publisher` IS the namespace: the id is
 *      immutable and a granted claim reassigns the publisher without touching it, so re-deriving
 *      from the prefix would lock a claimed entry out of the very updates the claim promised — and
 *      the same containment rule holds for entries that already conform, so a conforming
 *      replacement may not strip the stored publisher out of `operatingOrganizations` (a legacy row
 *      whose publisher was never one of its operating orgs is grandfathered and stays editable).
 *      See `authorizationNamespace` and the replace branch of `write`.
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
import {
  type Capabilities,
  type Principal,
  canWriteWith,
  effectiveCaps,
  hasVerifiedMembership,
} from "../../shared/capabilities.js";
import { HttpError, badRequest, conflict, forbidden, notFound } from "../../shared/http-error.js";
import { checkPublicId, namespaceOfPublicId, resolveNamespace } from "../../shared/namespace.js";
import { diffFields } from "../../shared/patch.js";
import { AuditService } from "../audit/audit.service.js";
import { violatedConstraint } from "../auth/account.service.js";
import type { RequestPrincipal } from "../auth/principal.service.js";
import type { DuplicateCheckResult } from "../dedupe/dedupe.service.js";

/** Per-field caps, enforced before anything is persisted. The body cap is on the route. */
export const FIELD_CAPS = {
  title: 256,
  summary: 1_000,
  description: 50_000,
  /** Any top-level array, and any organization array. */
  arrayEntries: 100,
} as const;

/**
 * The post-commit seam: work that must happen after the row exists and outside its transaction.
 *
 * Duplicate detection and source verification both belong here — an embedding call that fails must
 * not roll back a legitimate submission, and a source fetch must never hold a database transaction
 * open across the network.
 *
 * THE HOOK RETURNS, AND THE CALLER WAITS. Detection was originally fire-and-forget, which cannot
 * work: `duplicateCheck` and the suspected matches are part of the 201 body, and a result computed
 * after the response was sent is a result nobody receives. So `afterCommit` resolves to what the
 * response needs, the write awaits it, and the whole of it stays bounded by
 * `EMBEDDING_TIMEOUT_MS`. Anything genuinely fire-and-forget (queueing a source verification) is
 * started inside the hook and not awaited.
 *
 * A HOOK THAT THROWS IS SWALLOWED. The row is committed; public behaviour must never depend on a
 * post-commit enrichment succeeding, and the caller reports the honest `unavailable` instead.
 */
export interface WriteHooks {
  /**
   * A hook with nothing to contribute returns `undefined` rather than nothing at all: `void` in a
   * union is ambiguous about whether the value may be inspected, and this one is inspected.
   */
  afterCommit?(
    event: AfterCommitEvent,
  ): Promise<AfterCommitOutcome | undefined> | AfterCommitOutcome | undefined;
}

export interface AfterCommitEvent {
  opportunityId: number;
  publicId: string;
  namespace: string;
  created: boolean;
  principal: Principal;
}

/** What the post-commit work hands back to the response. */
export interface AfterCommitOutcome {
  duplicateCheck?: DuplicateCheckResult;
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
  /**
   * Whether duplicate detection ran, and what it found. Absent when the hook itself failed, which
   * the caller reports as `unavailable` — the honest answer, and the one the backfill job acts on.
   */
  duplicateCheck?: DuplicateCheckResult;
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

    // The id may not change, whatever else does. Checked before anything is looked up, because a
    // mismatch means the request is about two different entries and no answer to it is right.
    if (options.mode === "replace" && options.pathId !== undefined) {
      if (document.id !== options.pathId) {
        throw badRequest(
          "id_immutable",
          `\`id\` is immutable: the body says ${JSON.stringify(document.id)} and the path says ${JSON.stringify(options.pathId)}.`,
        );
      }
    }

    // The credential half of "may you write at all" does not depend on any namespace, and asking it
    // first keeps a caller who cannot write from learning whether an id exists.
    if (!canWriteWith(principal)) {
      throw forbidden(
        "missing_scope",
        "writing requires the `write` scope (or the stronger `publish`) on an API key.",
      );
    }

    const existing = await this.findByPublicId(document.id);
    const namespace = this.authorizationNamespace(document, existing);
    const caps = effectiveCaps(principal, namespace);
    // Decided once and carried: it changes what the provenance rules do, what the review status
    // does, and what the audit row says. Re-deriving it at each of those three would eventually
    // give three answers.
    const editorial = isEditorialWrite(principal, caps, existing, namespace);
    const now = new Date();
    const attributed = this.applyProvenance(document, {
      principal,
      caps,
      namespace,
      now,
      existing,
      editorial,
    });

    if (options.mode === "create" && existing) {
      // An identical repeat by the ORIGINAL submitter succeeds; anything else — including a
      // different account reaching for an id that is taken — is one undifferentiated 409. A 403
      // here would confirm to a stranger that the id exists and who it belongs to.
      const repeat = this.identicalRepeat(principal, attributed, existing);
      if (repeat) {
        // The post-commit work runs for a repeat too. Nothing changed, so the embedding is skipped
        // on its content hash — but the caller gets the SAME answer the original create gave, which
        // is what makes a retry idempotent rather than merely non-destructive.
        const outcome = await this.runAfterCommit({
          opportunityId: existing.id,
          publicId: existing.publicId,
          namespace,
          created: false,
          principal,
        });
        return { ...repeat, duplicateCheck: outcome?.duplicateCheck };
      }
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
      // The CREATE-time containment rule, applied to the STORED publisher — but ONLY to entries
      // that already conform to it. For a conforming entry a replacement may not strip out the
      // operating organisation that authorises it (so `acme:x` cannot be edited to drop `acme` from
      // `operatingOrganizations` while staying published under `acme`); rejected as the SAME 400 the
      // create-time gate uses, not a silent requeue.
      //
      // "Conforms" is read off the EXISTING row: the stored `source_publisher` is one of the row's
      // own operating-org slugs. Legacy import/seed rows whose publisher was NEVER one of their
      // operating orgs (14 in the seed corpus — e.g. `fundingmap:1042`, publisher `optimism`,
      // operator `optimism-foundation`) are GRANDFATHERED: the containment rule did not hold when
      // they were loaded, so enforcing it on edit would lock them out of ordinary content
      // corrections. Claimed entries are unaffected — a granted claim already requires the claimant
      // to be an operating org, so their stored publisher IS one. The `!== null` narrows the
      // publisher to a string for both membership checks below.
      if (
        existing.sourcePublisher !== null &&
        operatingSlugsOf(existing.operatingOrganizations).includes(existing.sourcePublisher) &&
        !operatingSlugs(document).includes(existing.sourcePublisher)
      ) {
        throw badRequest(
          "publisher_not_operating",
          `this entry is published under ${JSON.stringify(existing.sourcePublisher)}; a replacement must keep that organisation in \`operatingOrganizations\`.`,
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
      editorial,
      warnings: warnings.map((warning) => warning.message),
    });
  }

  /**
   * The namespace authorization is decided against — and it is a different question on a create
   * than on a replace.
   *
   * ON A CREATE it comes from the document (`source.publisher`, else the primary operating
   * organisation) and the id MUST carry it as a prefix. That rule is what keeps `source_system`
   * derivable from the id and `ux_opp_source` meaningful, and it is enforced here, once, at the
   * only moment an id is chosen.
   *
   * ON A REPLACE the row already exists and its namespace is a STORED FACT — `source_publisher`,
   * which a granted claim reassigns. Re-deriving it from the id prefix would strand every claimed
   * entry: an aggregator's `host:123` claimed by `operator` keeps its immutable id, so a rule that
   * required the prefix to match the current publisher would reject the very updates the claim
   * promised. The id-prefix rule is therefore a CREATE-time rule plus an immutability rule, not a
   * per-write invariant — and reading the namespace from the row rather than the body is also what
   * stops a submitter from restating `source.publisher` to move an entry into a namespace they do
   * hold a membership on.
   */
  private authorizationNamespace(
    document: Opportunity,
    existing: OpportunityRow | undefined,
  ): string {
    if (existing) {
      // The `??` chain is ordered by authority: the stored publisher, then the id it was created
      // under. The last fallback is unreachable for anything this service created (a create
      // enforces the prefix) and exists so a hand-loaded row cannot produce an empty namespace,
      // which would match a membership on `""`.
      return (
        existing.sourcePublisher ?? namespaceOfPublicId(existing.publicId) ?? existing.publicId
      );
    }
    const namespace = resolveNamespace(document);
    if (namespace === undefined) {
      throw badRequest(
        "namespace_required",
        "a submission must name the namespace it is published under: set `source.publisher` to an organisation slug, or give `operatingOrganizations[0].slug`.",
      );
    }
    // You may only publish under an organisation that OPERATES the programme. The namespace is the
    // publishing org — `source.publisher`, else `operatingOrganizations[0].slug` — and requiring it
    // to appear among `operatingOrganizations` closes the hole where a verified member of `acme`
    // publishes a programme operated solely by `globex` straight to public. When `source.publisher`
    // is absent the namespace IS `operatingOrganizations[0].slug`, so this holds trivially; the
    // check only bites when a stated publisher names an org that does not run the programme.
    if (!operatingSlugs(document).includes(namespace)) {
      throw badRequest(
        "publisher_not_operating",
        `\`source.publisher\` is ${JSON.stringify(namespace)}, which does not operate this programme. You may only publish under an organisation named in \`operatingOrganizations\`.`,
      );
    }
    const idProblem = checkPublicId(document.id, namespace);
    if (idProblem) throw badRequest("invalid_id", idProblem);
    return namespace;
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
   *
   * AN EDITORIAL REPLACEMENT ATTRIBUTES NOTHING TO THE EDITOR. A reviewer correcting a typo in
   * somebody else's entry is not its submitter and did not ingest it, so re-deriving attribution
   * from the acting principal would publicly reattribute the whole submission to whoever last
   * touched it — and after approval that credit is what the public detail route serves. So on an
   * editorial write every attribution member comes off the stored row instead. `publisher` needs no
   * branch: on a replace `namespace` IS the row's `source_publisher` (`authorizationNamespace`),
   * and `submittedAt` needs none either — it was already preserved for everybody, because when an
   * entry first arrived is a fact about the entry rather than about the most recent edit.
   */
  private applyProvenance(
    document: Opportunity,
    ctx: {
      principal: RequestPrincipal;
      caps: Capabilities;
      namespace: string;
      now: Date;
      existing: OpportunityRow | undefined;
      editorial: boolean;
    },
  ): Opportunity {
    const { principal, caps, namespace, now, existing, editorial } = ctx;
    const publishingAsOrg = principal.memberships.some((m) => m.slug === namespace && m.verified);
    const submittedBy = editorial
      ? (existing?.sourceSubmittedBy ?? undefined)
      : publishingAsOrg
        ? namespace
        : (principal.account.handle ?? "community");

    return {
      ...document,
      source: {
        ...(document.source ?? {}),
        publisher: namespace,
        submittedBy,
        // Preserved across an update: when the entry first arrived is a fact about the entry, not
        // about the most recent edit.
        submittedAt: (existing?.sourceSubmittedAt ?? now).toISOString(),
        ingestedVia: editorial
          ? (existing?.ingestedVia ?? undefined)
          : principal.credentialKind === "api_key"
            ? "publisher_api"
            : "submission",
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
    editorial: boolean;
    warnings: string[];
  }): Promise<WriteResult> {
    const { principal, caps, namespace, document, existing, now, editorial } = ctx;
    const { opp } = fromStandard(document, now);
    const autoApprove = caps.canPublishImmediately;

    /**
     * Whether this replacement actually says anything different.
     *
     * The SAME normalized projection the identical-repeat rule uses — content only, no server-owned
     * bookkeeping — so "changed" means changed AS STORED rather than changed as typed. A create is
     * a change by definition.
     */
    const contentChanged =
      existing === undefined ||
      Object.keys(
        diffFields(
          comparable(existing) as Record<string, unknown>,
          comparable(opp) as Record<string, unknown>,
        ),
      ).length > 0;

    /**
     * A CONTENT-CHANGING edit that cannot auto-publish RETURNS THE ENTRY TO THE QUEUE.
     *
     * Preserving `approved` unconditionally was a hole with no floor to it: `PUT` replaces the
     * whole record, so the original T1 submitter of an entry a reviewer had approved could rewrite
     * its title, description, amounts and application URL and have every word of it stay public,
     * unreviewed. The prior decision was about the prior content and does not carry over to content
     * nobody has seen.
     *
     * REQUEUEING AN UNCHANGED ENTRY IS THE OPPOSITE MISTAKE, and just as user-visible: opening the
     * dashboard's edit form and pressing Save without typing anything would unpublish a live entry
     * and put a reviewer's queue to work on a decision they had already made. The approval is about
     * the content, so it survives exactly as long as the content does.
     */
    const requeued = !autoApprove && existing?.reviewStatus === "approved" && contentChanged;

    const values: OpportunityInsert = {
      ...opp,
      // Pinned to the id, which is immutable — NOT to the current publisher, which a granted claim
      // reassigns. `ux_opp_source` is `(source_system, original_id)`, so letting a claim move the
      // system half would change a cross-system key that other systems resolve against.
      sourceSystem: existing?.sourceSystem ?? namespaceOfPublicId(document.id) ?? namespace,
      reviewStatus: autoApprove
        ? "approved"
        : contentChanged
          ? "pending"
          : (existing?.reviewStatus ?? "pending"),
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
        const actor = {
          actorKind:
            principal.credentialKind === "api_key" ? ("api_key" as const) : ("user" as const),
          actorAccountId: principal.accountId,
          actorApiKeyId: principal.apiKeyId ?? null,
        };
        await this.audit.record(tx, {
          ...actor,
          subjectKind: "opportunity",
          subjectId: stored.id,
          action: created ? "create" : "update",
          // Recorded ONLY when the writer is acting editorially — a reviewer editing somebody
          // else's entry, which is the one case where "who wrote this" is not answered by the
          // entry's own ownership. Stamping the role on every ordinary publisher write would put
          // `actorRole` in the public `changedFields` of every entry in the corpus, where it is
          // noise. Recorded at write time rather than read time because a role is revocable and
          // the trail must say what was true when the action was taken.
          patch: editorial ? { ...patch, actorRole: principal.role } : patch,
        });
        // An auto-approval is a second, separate decision and gets its own row: "created" and
        // "published without review" are different facts and a reader must be able to see both.
        if (autoApprove && existing?.reviewStatus !== "approved") {
          await this.audit.record(tx, {
            ...actor,
            subjectKind: "opportunity",
            subjectId: stored.id,
            action: "approve",
            patch: {
              reviewStatus: { before: existing?.reviewStatus ?? null, after: "approved" },
              reason: "verified_publisher_namespace",
            },
          });
        }
        // …and so is the reverse. The audit action enum is closed and gains nothing here: `update`
        // with a patch naming the transition and its reason says exactly what happened, and the
        // alternative is an `ALTER TYPE` migration for a verb the trail can already express.
        if (requeued) {
          await this.audit.record(tx, {
            ...actor,
            subjectKind: "opportunity",
            subjectId: stored.id,
            action: "update",
            patch: {
              reviewStatus: { before: "approved", after: "pending" },
              reason: "replaced_without_auto_approval",
            },
          });
        }
        return stored;
      })
      .catch((error: unknown) => {
        throw translateWriteFailure(error, document);
      });

    const outcome = await this.runAfterCommit({
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
      duplicateCheck: outcome?.duplicateCheck,
      row,
    };
  }

  /** The post-commit seam. A hook failure is never allowed to un-store a stored entry. */
  private async runAfterCommit(event: AfterCommitEvent): Promise<AfterCommitOutcome | undefined> {
    if (!this.hooks.afterCommit) return undefined;
    try {
      return (await this.hooks.afterCommit(event)) ?? undefined;
    } catch {
      // Deliberately swallowed: the row is committed and public behaviour must not depend on a
      // post-commit enrichment succeeding. The hook owns its own logging and retry (a backfill job).
      return undefined;
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

/** The slugs of a list of operating organisations — a stored row's array, or a document's. */
function operatingSlugsOf(orgs: readonly { slug: string }[]): string[] {
  return orgs.map((org) => org.slug);
}

/**
 * The slugs of the organisations that OPERATE this programme — who runs intake and the process,
 * never a sponsor. This is the set the publishing namespace must belong to (the write-side twin of
 * the claim service's operating-vs-sponsoring rule): sponsorship is recorded, but it does not
 * authorise publishing.
 */
function operatingSlugs(document: Opportunity): string[] {
  return operatingSlugsOf(document.operatingOrganizations ?? []);
}

/**
 * Whether this principal may write over an entry that already exists: the submitter, a verified
 * publisher of the namespace the row is filed under, or T3+.
 *
 * `namespace` is the ROW's namespace (see `authorizationNamespace`), so the membership arm is a
 * question about the entry rather than about what the body claimed.
 *
 * T3+ IS DELIBERATE, and the earlier comment here saying the opposite was simply wrong: the
 * approved design grants `PUT` to the submitter, a namespace member, or T3+, and a reviewer who
 * can approve an entry outright but cannot correct a typo in it would reach for the approval
 * button as the only tool they have. `caps.canReview` is session-only and covers admins, so a
 * leaked reviewer key still cannot write over anything — and an editorial write is stamped with
 * the actor's role in the audit trail, so it is distinguishable from the publisher's own.
 */
function mayWriteExisting(
  principal: Principal,
  caps: Capabilities,
  existing: OpportunityRow,
  namespace: string,
): boolean {
  if (existing.submittedBy === principal.accountId) return true;
  if (hasVerifiedMembership(principal, namespace)) return true;
  return caps.canReview;
}

/** A write over somebody else's entry, permitted only by the editorial role. */
function isEditorialWrite(
  principal: Principal,
  caps: Capabilities,
  existing: OpportunityRow | undefined,
  namespace: string,
): boolean {
  if (!existing || !caps.canReview) return false;
  if (existing.submittedBy === principal.accountId) return false;
  return !hasVerifiedMembership(principal, namespace);
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
