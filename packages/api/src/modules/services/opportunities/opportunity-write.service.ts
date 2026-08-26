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
 *      the same containment rule holds on replace, so a replacement may not strip the stored
 *      publisher out of `operatingOrganizations`. The one exemption is import-provenance-scoped: a
 *      row that entered through a legacy ingest route (`ingestedVia ∈ {import, scrape, outbox}`) AND
 *      never conformed is grandfathered and stays editable; a `publisher_api`/`submission` row went
 *      through the create-time gate and is held to containment on replace. See
 *      `authorizationNamespace` and the replace branch of `write`.
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
 * THE DECISION IS MADE UNDER THE ROW LOCK, NOT BEFORE IT. Every step above runs twice: once
 * unlocked, as a fail-fast that answers the cheap 400/403/404 without opening a transaction, and
 * once inside `persist`'s transaction against `SELECT … FOR UPDATE` on the row plus a re-proved
 * membership (`resolvePublishAuthority`). Nothing the unlocked pass derives reaches the write.
 * Recomputing only the content diff would not be enough: between the two passes a granted claim can
 * move the namespace, a revocation can remove the authority that was about to auto-publish, and
 * another writer can replace the whole document — so the namespace, the capabilities, the
 * ownership and containment checks, the provenance, the requeue decision and the audit patch are
 * all re-derived from what the lock actually holds. A row that vanished between the two is a 409,
 * never a silent create.
 *
 * IDEMPOTENCY WITHOUT A KEY TABLE. A `POST` whose id already exists is compared field by field
 * against the stored row through the same normalized projection that produced it. Byte-identical and
 * from the original submitter → the original result, as a 200: a retried create succeeds instead of
 * punishing a flaky network. Anything else → 409.
 */
import type { Opportunity } from "@the-rfp-hub/standard";
import { and, count, eq } from "drizzle-orm";
import { humanizeErrors, humanizeIssues, validateOpportunity } from "rfphub-validate";
import { config as defaultConfig } from "../../../config.js";
import { type DB, type Tx, db as defaultDb } from "../../../db/client.js";
import {
  type OpportunityInsert,
  type OpportunityRow,
  accounts,
  opportunities,
  organizations,
} from "../../../db/schema.js";
import { fromStandard, organizationInserts, toStandard } from "../../mappers/opportunity.mapper.js";
import { repositories } from "../../repositories/index.js";
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
import {
  type PublishAuthorityResolver,
  hasAnyVerifiedMembership,
  resolvePublishAuthority,
} from "../auth/publish-authority.js";
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

/** What the decision block derives, from one row and one principal. The namespace is its input. */
interface WriteDecision {
  caps: Capabilities;
  editorial: boolean;
  /** The document with every attribution field set by the server. */
  attributed: Opportunity;
}

export class OpportunityWriteService {
  private readonly audit: AuditService;

  constructor(
    private readonly db: DB = defaultDb,
    private readonly hooks: WriteHooks = {},
    private readonly publishAuthority: PublishAuthorityResolver = resolvePublishAuthority,
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
        {
          errors: humanizeErrors(errors, record),
          issues: humanizeIssues(errors, record),
        },
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

    // FAIL-FAST ONLY, and deliberately unlocked: it exists so a malformed, unauthorized or unknown
    // write is refused without opening a transaction. Everything it derives is ADVISORY and none of
    // it reaches the write — `persist` derives the same answers again from the locked row.
    const preview = await this.findByPublicId(document.id);
    if (options.mode === "replace" && !preview) {
      throw notFound(`no opportunity ${JSON.stringify(document.id)}.`);
    }
    if (preview && preview.mergedIntoId !== null) {
      throw opportunityMerged(preview.publicId);
    }
    const namespace = this.authorizationNamespace(document, preview);
    const advisory = this.decide({
      principal,
      document,
      existing: preview,
      namespace,
      mode: options.mode,
      now: new Date(),
    });

    if (options.mode === "create" && preview) {
      // An identical repeat by the ORIGINAL submitter succeeds; anything else — including a
      // different account reaching for an id that is taken — is one undifferentiated 409. A 403
      // here would confirm to a stranger that the id exists and who it belongs to.
      //
      // Decided on the unlocked read on purpose: neither branch writes anything, and the losing
      // half of a create/create race is answered by the unique constraint under the lock instead.
      const repeat = this.identicalRepeat(principal, advisory.attributed, preview);
      if (repeat) {
        // The post-commit work runs for a repeat too. Nothing changed, so the embedding is skipped
        // on its content hash — but the caller gets the SAME answer the original create gave, which
        // is what makes a retry idempotent rather than merely non-destructive.
        const outcome = await this.runAfterCommit({
          opportunityId: preview.id,
          publicId: preview.publicId,
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

    return this.persist({
      principal,
      document,
      mode: options.mode,
      warnings: warnings.map((warning) => warning.message),
    });
  }

  /**
   * The whole write decision, from ONE row and ONE principal: what the caller may do here, whether
   * this is an editorial write, and the document as the server will store it.
   *
   * Pure with respect to the database — it is called once unlocked as a fail-fast and once inside
   * the writing transaction, and the second answer is the one that lands. The rules that can refuse
   * a replacement (ownership, and the operating-org containment rule) live here rather than in
   * `write` for exactly that reason: a caller who lost their authority between the two passes must
   * be refused by the second one, not carried by the first.
   */
  private decide(ctx: {
    principal: RequestPrincipal;
    document: Opportunity;
    existing: OpportunityRow | undefined;
    namespace: string;
    mode: "create" | "replace";
    now: Date;
  }): WriteDecision {
    const { principal, document, existing, namespace, mode, now } = ctx;
    const caps = effectiveCaps(principal, namespace);
    // Decided once and carried: it changes what the provenance rules do, what the review status
    // does, and what the audit row says. Re-deriving it at each of those three would eventually
    // give three answers.
    const editorial = isEditorialWrite(principal, caps, existing, namespace);

    if (mode === "replace" && existing) {
      if (!mayWriteExisting(principal, caps, existing, namespace)) {
        throw forbidden(
          "not_your_entry",
          "that entry was submitted by another account and you are not a verified publisher of its namespace.",
        );
      }
      // The CREATE-time containment rule, applied to the STORED publisher on replace — with a
      // narrow, PROVENANCE-SCOPED exemption for legacy imports.
      //
      // A replacement may not strip out the operating organisation that authorises the entry: for a
      // row whose stored `source_publisher` is one of its OWN operating-org slugs, dropping that org
      // from `operatingOrganizations` is a 400 (the same code the create gate uses), so `acme:x`
      // cannot be edited to remove `acme` while staying published under `acme`.
      //
      // The exemption is import-provenance-scoped, NOT merely "non-conforming". A row is
      // grandfathered only when it BOTH (a) entered through a legacy ingest route
      // (`ingestedVia ∈ {import, scrape, outbox}`) AND (b) never conformed — its stored publisher was
      // never one of its operating orgs (the 14 seed-corpus rows: e.g. `fundingmap:1042`, published
      // under `optimism`, operated by `optimism-foundation`). Those never passed the create-time
      // gate, so enforcing containment on edit would only lock them out of ordinary corrections. A
      // row created through the AUTHENTICATED write path (`publisher_api`/`submission`) went through
      // that gate and must stay conforming: a foreign-operated one of those is still rejected on
      // replace, never grandfathered. Claimed entries are unaffected — a granted claim already
      // requires the claimant to be an operating org, so their publisher conforms.
      const storedPublisher = existing.sourcePublisher;
      if (storedPublisher !== null && !operatingSlugs(document).includes(storedPublisher)) {
        const neverConformed = !operatingSlugsOf(existing.operatingOrganizations).includes(
          storedPublisher,
        );
        const legacyIngest = LEGACY_INGEST_ORIGINS.has(existing.ingestedVia ?? "");
        const grandfathered = legacyIngest && neverConformed;
        if (!grandfathered) {
          throw badRequest(
            "publisher_not_operating",
            `this entry is published under ${JSON.stringify(storedPublisher)}; a replacement must keep that organization in \`operatingOrganizations\`.`,
          );
        }
      }
    }

    return {
      caps,
      editorial,
      attributed: this.applyProvenance(document, {
        principal,
        caps,
        namespace,
        now,
        existing,
        editorial,
      }),
    };
  }

  /**
   * The principal, with the two facts that decide auto-publication re-read inside this transaction.
   *
   * `memberships` is narrowed to the ONE namespace being written, deliberately: every consumer
   * downstream asks about this namespace and nothing else, so keeping the auth-time list for the
   * account's other organisations would only leave a stale answer lying around where a later change
   * could consult it.
   */
  private async reproveAuthority(
    tx: Tx,
    principal: RequestPrincipal,
    namespace: string,
  ): Promise<RequestPrincipal> {
    const authority = await this.publishAuthority(repositories(tx), principal.accountId, namespace);
    return {
      ...principal,
      directCreate: authority.directCreate,
      memberships: authority.member ? [{ slug: namespace, verified: authority.verified }] : [],
    };
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
        "a submission must name the namespace it is published under: set `source.publisher` to an organization slug, or give `operatingOrganizations[0].slug`.",
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
        `\`source.publisher\` is ${JSON.stringify(namespace)}, which does not operate this programme. You may only publish under an organization named in \`operatingOrganizations\`.`,
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

  /**
   * The write itself — and the ONLY place the decision that lands is made.
   *
   * The transaction opens with `SELECT … FOR UPDATE` on the row and re-proves the account's
   * authority over the namespace (`reproveAuthority`), then re-derives everything from those two:
   * a concurrent replacement, a granted claim that moved the publisher, and a revoked membership
   * are all visible here and none of them are visible to the unlocked read in `write`.
   */
  private async persist(ctx: {
    principal: RequestPrincipal;
    document: Opportunity;
    mode: "create" | "replace";
    warnings: string[];
  }): Promise<WriteResult> {
    const committed = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(opportunities)
        .where(eq(opportunities.publicId, ctx.document.id))
        .for("update")
        .limit(1);
      const existing = locked[0];

      if (existing && existing.mergedIntoId !== null) {
        throw opportunityMerged(existing.publicId);
      }

      if (ctx.mode === "create" && existing) {
        // Created by somebody else between the fail-fast read and this lock. The same answer the
        // unique constraint would give a statement later, given here so the create path can never
        // fall into the update branch.
        throw conflict(
          "id_conflict",
          `an opportunity with id ${JSON.stringify(ctx.document.id)} already exists.`,
        );
      }
      if (ctx.mode === "replace" && !existing) {
        // The row was there when the request was validated and is gone now. A replacement is not a
        // create, so the only honest answer is that the request lost a race.
        throw conflict(
          "write_conflict",
          `opportunity ${JSON.stringify(ctx.document.id)} was removed while this replacement was being applied.`,
        );
      }

      return this.applyWrite(tx, { ...ctx, existing });
    });

    const outcome = await this.runAfterCommit({
      opportunityId: committed.row.id,
      publicId: committed.row.publicId,
      namespace: committed.namespace,
      created: committed.created,
      principal: ctx.principal,
    });

    return {
      opportunity: toStandard(committed.row),
      created: committed.created,
      reviewStatus: committed.row.reviewStatus,
      isListed: committed.row.isListed,
      warnings: ctx.warnings,
      repeated: false,
      duplicateCheck: outcome?.duplicateCheck,
      row: committed.row,
    };
  }

  /** Everything inside the lock: re-decide, write the row, write the history. */
  private async applyWrite(
    tx: Tx,
    ctx: {
      principal: RequestPrincipal;
      document: Opportunity;
      mode: "create" | "replace";
      existing: OpportunityRow | undefined;
    },
  ): Promise<{ row: OpportunityRow; namespace: string; created: boolean }> {
    const { existing } = ctx;
    const now = new Date();
    const namespace = this.authorizationNamespace(ctx.document, existing);
    // WHETHER THIS WRITE COULD PUT SOMETHING INTO THE REVIEW QUEUE — which is a create, and equally
    // an edit of an entry that is NOT currently pending, because a content-changing replacement of
    // an approved or rejected entry returns it to the queue (see `requeued` below). Metering only
    // creates left the ceiling trivially bypassable: an account at its limit could edit its own
    // older entries, one after another, and grow the queue without ever creating anything.
    //
    // An entry already pending is exempt: replacing it occupies the slot it already holds.
    const mayEnterQueue = existing === undefined || existing.reviewStatus !== "pending";
    // BEFORE `reproveAuthority`, which reads this same row FOR SHARE. Taking the exclusive lock
    // first is not a preference: two such writes by one account would otherwise both hold the
    // shared lock and both try to upgrade it, and Postgres answers that with a deadlock rather than
    // a queue. Observed, not theorised — see `assertPendingHeadroom` for what the lock is FOR.
    if (mayEnterQueue) await lockAccountRow(tx, ctx.principal.accountId);
    const principal = await this.reproveAuthority(tx, ctx.principal, namespace);
    const { caps, editorial, attributed } = this.decide({
      principal,
      document: ctx.document,
      existing,
      namespace,
      mode: ctx.mode,
      now,
    });
    const document = attributed;
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
    // The transition that costs a slot: something that was not in the queue is now in it. A create
    // that auto-publishes never gets here, and neither does an edit of an entry that was already
    // pending.
    if (mayEnterQueue && values.reviewStatus === "pending") {
      await this.assertPendingHeadroom(tx, principal.accountId);
    }

    await insertOrganizationStubs(tx, document);

    const written = await (existing === undefined
      ? tx.insert(opportunities).values(values).returning()
      : tx.update(opportunities).set(values).where(eq(opportunities.id, existing.id)).returning()
    ).catch((error: unknown) => {
      // Translated here rather than around the whole transaction so the message is built from the
      // document as the SERVER attributed it — the only unique keys a client can collide with are
      // the ones the server chose to accept.
      throw translateWriteFailure(error, document);
    });
    const stored = written[0];
    if (!stored) throw new Error(`failed to persist ${document.id}`);

    const patch = diffFields(
      existing ? (comparable(existing) as Record<string, unknown>) : {},
      comparable(stored) as Record<string, unknown>,
    );
    const actor = {
      actorKind: principal.credentialKind === "api_key" ? ("api_key" as const) : ("user" as const),
      actorAccountId: principal.accountId,
      actorApiKeyId: principal.apiKeyId ?? null,
    };
    await this.audit.record(tx, {
      ...actor,
      subjectKind: "opportunity",
      subjectId: stored.id,
      action: created ? "create" : "update",
      // Recorded ONLY when the writer is acting editorially — a reviewer editing somebody else's
      // entry, which is the one case where "who wrote this" is not answered by the entry's own
      // ownership. Stamping the role on every ordinary publisher write would put `actorRole` in the
      // public `changedFields` of every entry in the corpus, where it is noise. Recorded at write
      // time rather than read time because a role is revocable and the trail must say what was true
      // when the action was taken.
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
    return { row: stored, namespace, created };
  }

  /**
   * The review queue is a shared resource, so one account may not fill it.
   *
   * WHO IT APPLIES TO: an account holding NO verified membership anywhere. A verified publisher's
   * own writes auto-approve and never reach the queue at all, and metering their proposals into
   * OTHER namespaces because of where they publish would punish exactly the people the Hub has
   * already vouched for. So the exemption is total rather than per-namespace.
   *
   * WHAT IT COUNTS: rows CURRENTLY pending and owned by this account. It is a ceiling on the queue,
   * not a quota on a lifetime — every decision a reviewer makes frees a slot, and so does the
   * submitter's own edit that gets approved.
   *
   * WHEN IT RUNS: on every transition INTO the queue, not merely on creates. A content-changing
   * replacement of an approved or rejected entry requeues it, so metering creates alone would have
   * left the ceiling bypassable by editing old entries in turn. Replacing an entry that is ALREADY
   * pending is exempt — it occupies the slot it already holds, and charging it again would stop an
   * account at the limit from correcting its own submissions, which is the opposite of what a
   * review queue wants.
   *
   * COUNT-THEN-INSERT UNDER THE ACCOUNT'S LOCK, which is the pattern `api-key.service.ts` uses for
   * the 25-key limit and for the same reason: two concurrent creates that both counted 4 would both
   * insert a 5th. The account row is the natural per-account serialisation point and needs no new
   * advisory-lock namespace. The lock itself is taken at the TOP of `applyWrite` (see
   * `lockAccountRow`); only the counting happens here.
   */
  private async assertPendingHeadroom(tx: Tx, accountId: number): Promise<void> {
    const limit = defaultConfig.pendingSubmissionLimit;
    if (await hasAnyVerifiedMembership(repositories(tx), accountId)) return;

    const counted = await tx
      .select({ value: count() })
      .from(opportunities)
      .where(
        and(eq(opportunities.submittedBy, accountId), eq(opportunities.reviewStatus, "pending")),
      );
    const pending = counted[0]?.value ?? 0;
    if (pending < limit) return;

    throw conflict(
      "pending_limit_reached",
      `you have ${pending} submissions awaiting review, which is the limit of ${limit} for an account without a verified publisher membership. A slot frees as soon as one of them is approved or rejected.`,
    );
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
 * The per-account serialisation point for a create.
 *
 * Taken EXCLUSIVELY and taken FIRST. The write path reads this same row again a moment later, at
 * `FOR SHARE`, to answer "may this account publish anywhere without a membership" — and a
 * transaction that holds a shared lock and then asks for an exclusive one on the same row is a
 * deadlock waiting for a second transaction to do the same thing. Two concurrent submissions by one
 * account is exactly that pair, and Postgres reports it as `deadlock detected` on this very
 * statement. Acquiring the strongest level once, up front, is the standard remedy and the reason
 * this is not simply folded into the check that needs it.
 */
async function lockAccountRow(tx: Tx, accountId: number): Promise<void> {
  await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .for("update");
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
  const issues: { path: string; message: string }[] = [];
  for (const [field, cap] of [
    ["title", FIELD_CAPS.title],
    ["summary", FIELD_CAPS.summary],
    ["description", FIELD_CAPS.description],
  ] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > cap) {
      problems.push(`\`${field}\` must be at most ${cap} characters (got ${value.length}).`);
      issues.push({
        path: `/${field}`,
        message: `must be at most ${cap} characters (got ${value.length}).`,
      });
    }
  }
  for (const [field, value] of Object.entries(record)) {
    if (Array.isArray(value) && value.length > FIELD_CAPS.arrayEntries) {
      problems.push(
        `\`${field}\` must have at most ${FIELD_CAPS.arrayEntries} entries (got ${value.length}).`,
      );
      issues.push({
        path: `/${field}`,
        message: `must have at most ${FIELD_CAPS.arrayEntries} entries (got ${value.length}).`,
      });
    }
  }
  if (problems.length > 0) {
    throw new HttpError(400, "validation_failed", "the submission exceeds the size limits.", {
      errors: problems,
      issues,
    });
  }
}

/**
 * The ingest routes that predate — or bypass — the create-time operating-org gate. A row that
 * entered through one of these and never conformed is grandfathered on replace (see `write`); a row
 * created through the authenticated write path (`publisher_api`/`submission`) went through the gate
 * and is not. A null `ingestedVia` is treated as non-legacy (fail closed toward enforcement).
 */
const LEGACY_INGEST_ORIGINS: ReadonlySet<string> = new Set(["import", "scrape", "outbox"]);

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
  "mergedFromPublic",
  "sourceSubmittedAt",
  "verifiedAgainstSource",
  "verifiedAt",
  "snapshotUrl",
  "nextDeadlineAt",
  "sourceSystem",
]);

function opportunityMerged(publicId: string): HttpError {
  return conflict(
    "opportunity_merged",
    `opportunity ${JSON.stringify(publicId)} has been merged and cannot be changed.`,
  );
}

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
 *
 * THE PUBLIC-ID ARM IS THE ONLY ANSWER THE CREATE/CREATE RACE HAS. Two creates of the same absent
 * id both pass the `FOR UPDATE` lookup — PostgreSQL does not lock a row that is not there — and the
 * loser's INSERT raises 23505. It is named `opportunities_publicId_unique` (migration 0000), a
 * drizzle-generated name that carries the COLUMN in camelCase while the column itself is
 * `public_id`, so matching on the snake_case spelling missed it and turned a 409 into a 500.
 * Matching a case- and separator-insensitive form covers both spellings and survives a regenerated
 * constraint name; `test/integration/write-concurrency.test.ts` pins it against the real database.
 */
function namesPublicId(constraint: string): boolean {
  return constraint
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .includes("publicid");
}

export function translateWriteFailure(error: unknown, document: Opportunity): unknown {
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
  if (constraint !== undefined && namesPublicId(constraint)) {
    return conflict(
      "id_conflict",
      `an opportunity with id ${JSON.stringify(document.id)} already exists.`,
    );
  }
  return error;
}
