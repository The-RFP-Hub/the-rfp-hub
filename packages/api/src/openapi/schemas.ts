/**
 * Reusable response schemas, registered on the Fastify instance so both the OpenAPI 3.1 document
 * (served at /v1/docs/json) and the response serializer reference them by `$ref`.
 *
 * The two opportunity components are DERIVED from `@the-rfp-hub/standard` (see ./standard.ts):
 * every property, enum, format and the `required` list come out of the canonical JSON Schema at
 * module load, so the published contract cannot drift from the Standard. Only what the Standard
 * cannot know is written by hand here — the list/detail split, and the components that are not
 * part of the Standard at all (Stats, Health, ErrorResponse, …).
 *
 * `Opportunity` uses `additionalProperties: true` on purpose: the serializer must pass a full
 * Standard object through untouched, so a Standard that grows a field keeps serving it (the
 * drift-guard test in test/unit/openapi-drift.test.ts is what makes sure it also gets DOCUMENTED).
 * `OpportunitySummary` is the opposite case — a server-controlled projection with a closed shape.
 */
import { STANDARD_REQUIRED, detailOnly, standardProperty } from "./standard.js";

/** Every property `toSummary` emits — the fields shared by the list and detail projections. */
const summaryProperties = {
  specVersion: standardProperty("specVersion"),
  id: standardProperty("id"),
  fundingType: standardProperty("fundingType"),
  title: standardProperty("title"),
  description: standardProperty("description"),
  summary: standardProperty("summary"),
  status: standardProperty("status"),
  sponsoringOrganizations: standardProperty("sponsoringOrganizations"),
  operatingOrganizations: standardProperty("operatingOrganizations"),
  source: standardProperty("source"),
  ecosystems: standardProperty("ecosystems"),
  categories: standardProperty("categories"),
  eligibility: standardProperty("eligibility"),
  prerequisites: standardProperty("prerequisites"),
  additionalReferences: standardProperty("additionalReferences"),
  serviceAgreement: standardProperty("serviceAgreement"),
  applicationUrl: standardProperty("applicationUrl"),
  website: standardProperty("website"),
  logoUrl: standardProperty("logoUrl"),
  bannerUrl: standardProperty("bannerUrl"),
  socialLinks: standardProperty("socialLinks"),
  fundingInfo: standardProperty("fundingInfo"),
  milestones: standardProperty("milestones"),
  opensAt: standardProperty("opensAt"),
  deadlines: standardProperty("deadlines"),
  postedAt: standardProperty("postedAt"),
  createdAt: standardProperty("createdAt"),
  updatedAt: standardProperty("updatedAt"),
};

/**
 * The type-specific details, a single required slot: the Standard models `fundingDetails` as a
 * `oneOf` tagged union over the six detail shapes, each self-described by its required
 * `fundingType` tag (equal to the top-level `fundingType`). The derivation serves it as a
 * pass-through object, like every other `$defs`-backed sub-object.
 */
const fundingDetailsProperty = detailOnly(standardProperty("fundingDetails"));

export const responseSchemas: ({ $id: string } & Record<string, unknown>)[] = [
  {
    $id: "Opportunity",
    type: "object",
    description:
      "A full RFP Hub Standard opportunity, as served by GET /v1/opportunities/{id}: the shared fields plus `fundingDetails`, whose own `fundingType` tag names its shape.",
    additionalProperties: true,
    required: [...STANDARD_REQUIRED],
    properties: {
      ...summaryProperties,
      fundingDetails: fundingDetailsProperty,
    },
  },
  {
    $id: "OpportunitySummary",
    type: "object",
    description:
      "The thin list projection served by GET /v1/opportunities: a Standard opportunity minus `fundingDetails`. Fetch the detail endpoint for that.",
    additionalProperties: false,
    // The Standard requires `fundingDetails`; the summary is the one deliberate deviation — it is
    // a server-controlled projection that omits that slot, so it cannot require it either.
    required: STANDARD_REQUIRED.filter((name) => name !== "fundingDetails"),
    properties: { ...summaryProperties },
  },
  {
    $id: "PaginatedOpportunities",
    type: "object",
    additionalProperties: false,
    required: ["items", "page", "limit", "total", "totalPages"],
    properties: {
      items: { type: "array", items: { $ref: "OpportunitySummary" } },
      page: { type: "integer" },
      limit: { type: "integer" },
      total: { type: "integer" },
      totalPages: { type: "integer" },
    },
  },
  {
    $id: "DatasetExport",
    type: "object",
    description:
      "The whole public dataset in the published export envelope, as served by GET /v1/export/opportunities.json and as published in `exports/latest.json`. The two are the same bytes per record — only `generatedAt` differs, because a live download stamps itself with the time of the request.",
    additionalProperties: false,
    required: ["specVersion", "license", "generatedAt", "count", "opportunities"],
    properties: {
      specVersion: {
        type: "string",
        description: "RFP Hub Standard version every record in this document conforms to.",
      },
      license: {
        type: "string",
        description:
          "SPDX identifier the dataset is released under. Always `CC0-1.0` — the data is public domain; the repository's own MIT licence covers the code, not this.",
      },
      generatedAt: {
        type: "string",
        format: "date-time",
        description:
          "When this representation was produced — the time of the request, not of an ingest. The one field here that is not data.",
      },
      count: {
        type: "integer",
        description:
          "Records in `opportunities`. Zero is a valid answer: a download of an empty dataset is a complete document, not an error.",
      },
      opportunities: {
        type: "array",
        description:
          "Every public record as a full Standard object, ascending by `id` compared by code unit — the order the published archives use, imposed on the records rather than taken from a database collation.",
        items: { $ref: "Opportunity" },
      },
    },
  },
  {
    $id: "Stats",
    type: "object",
    additionalProperties: false,
    required: ["total", "byFundingType", "byStatus", "topEcosystems", "lastUpdatedAt"],
    properties: {
      total: { type: "integer" },
      byFundingType: { type: "object", additionalProperties: { type: "integer" } },
      byStatus: { type: "object", additionalProperties: { type: "integer" } },
      topEcosystems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ecosystem", "count"],
          properties: { ecosystem: { type: "string" }, count: { type: "integer" } },
        },
      },
      lastUpdatedAt: { type: ["string", "null"] },
    },
  },
  {
    $id: "SchemaResponse",
    type: "object",
    additionalProperties: true,
    description:
      "The canonical RFP Hub Standard JSON Schema document itself (JSON Schema draft 2020-12), served verbatim as application/schema+json. It self-identifies through its own $id and $schema members, so no envelope carries the version. Those two members are deliberately NOT declared as properties here: `$id` inside a registered component is read as a schema identifier by the OpenAPI ref resolver.",
    required: ["title", "type"],
    properties: {
      title: { type: "string", description: "Human-readable name of the schema." },
      type: { type: "string", description: "The JSON Schema `type` of an opportunity: object." },
    },
  },
  {
    $id: "JsonLdContext",
    type: "object",
    additionalProperties: true,
    description:
      "The RFP Hub Standard's JSON-LD context document, served verbatim as application/ld+json at its canonical URL. Its single top-level member is `@context`; the term mappings inside it are the Standard's, not this API's.",
    required: ["@context"],
    properties: {
      "@context": {
        type: "object",
        additionalProperties: true,
        description: "Term definitions mapping every Standard field to an IRI.",
      },
    },
  },
  {
    $id: "SpecVersionIndex",
    type: "object",
    additionalProperties: true,
    description:
      "Machine-readable index of published RFP Hub Standard versions, served verbatim at its canonical URL. `latest` names the current spec version; each entry's `path` is a sibling directory of the index.",
    required: ["versions", "latest"],
    properties: {
      versions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["version", "path", "status"],
          properties: {
            version: { type: "string", description: "The spec version, e.g. 1.0.0." },
            path: { type: "string", description: "Directory holding that version's artifacts." },
            status: { type: "string", description: "Maturity: draft or stable." },
          },
        },
      },
      latest: { type: "string", description: "The current spec version." },
    },
  },
  {
    $id: "Health",
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: {
      status: { type: "string" },
      db: { type: "string" },
      auth: {
        type: "object",
        additionalProperties: false,
        required: ["google"],
        description:
          "Which optional sign-in methods this deployment has configured, so a client can advertise only what exists. Email one-time codes are always available and are therefore not reported.",
        properties: {
          google: {
            type: "boolean",
            description: "True when the Google provider is registered (client id AND secret).",
          },
        },
      },
    },
  },
  // ── M3 components ──────────────────────────────────────────────────────────────
  // Every one of these closes its shape, so the serializer drops anything a controller returns
  // that is not declared. `modules/shared/api-views.ts` holds the producer types, and the drift
  // guard builds a typed sample of each — that pairing is what makes a silently-dropped field a
  // test failure rather than a mystery in production.
  {
    $id: "ValidationErrorResponse",
    type: "object",
    additionalProperties: false,
    description:
      "A rejected write. `errors` carries the humanized, field-by-field report when the body failed Standard validation — the reason the write routes install a pass-through Fastify validator and let the service validate instead. It is absent for the rejections that are about ONE thing (a mismatched id, a namespace that cannot be resolved), where the message is the whole answer.",
    required: ["error", "message"],
    properties: {
      error: { type: "string", description: "Stable machine-readable error code (snake_case)." },
      message: { type: "string", description: "Human-readable summary." },
      errors: {
        type: "array",
        items: { type: "string" },
        description: "One human-readable sentence per violation, naming the field and the rule.",
      },
      issues: {
        type: "array",
        description: "Structured field locations and messages corresponding to validation errors.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "message"],
          properties: {
            path: {
              type: "string",
              description: "A JSON Pointer, or the literal `(root)` for the whole document.",
            },
            message: { type: "string" },
          },
        },
      },
    },
  },
  {
    $id: "SubmissionResult",
    type: "object",
    additionalProperties: false,
    description:
      "The outcome of a create or replace. `reviewStatus` is `approved` only when the credential could publish into the resolved namespace — a submission that lands `pending` is stored and invisible to the public reads until a reviewer approves it.",
    required: [
      "opportunity",
      "created",
      "reviewStatus",
      "isListed",
      "warnings",
      "duplicateCheck",
      "duplicates",
    ],
    properties: {
      opportunity: { $ref: "Opportunity" },
      created: {
        type: "boolean",
        description:
          "True for a create, including an identical repeat of one (which returns 200 with the original result rather than a conflict).",
      },
      reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
      isListed: { type: "boolean" },
      warnings: {
        type: "array",
        items: { type: "string" },
        description:
          "Advisory check-tier findings. Never fatal — a conformant document may carry them.",
      },
      duplicateCheck: {
        type: "string",
        enum: ["ok", "unavailable", "disabled"],
        description:
          "Whether duplicate detection RAN. `ok` with an empty `duplicates` means checked and nothing similar; `unavailable` means the embedding call failed or timed out and a backfill still owes this entry a check; `disabled` means no provider is configured. Without this a client cannot tell the three apart. Detection never blocks a write — a failure is reported here, not as an error.",
      },
      duplicates: {
        type: "array",
        items: { $ref: "DuplicateMatch" },
        description:
          "Suspected matches, searched over PUBLICLY VISIBLE entries only — a duplicate check must never disclose another account's pending or unlisted title and id. `isPublic` is therefore deliberately always true in this SubmissionResult array, while the shared DuplicateMatch component also serves routes that can expose an owner-visible, non-public counterpart.",
      },
    },
  },
  {
    $id: "AuditEntry",
    type: "object",
    additionalProperties: false,
    description:
      "One recorded mutation. Public callers get the changed field NAMES and a coarse actor; the entry's submitter, its publisher and reviewers additionally get `patch`.",
    required: ["action", "at", "actorKind", "actor", "changedFields"],
    properties: {
      action: { type: "string" },
      at: { type: "string", format: "date-time" },
      actorKind: { type: "string", enum: ["user", "api_key", "job", "outbox"] },
      actor: {
        type: "string",
        description: "A public handle, an organization slug, `reviewer`, `job` or `community`.",
      },
      changedFields: { type: "array", items: { type: "string" } },
      patch: {
        type: "object",
        additionalProperties: true,
        description: "`{field: {before, after}}`. Present only for the owner and reviewers.",
      },
    },
  },
  {
    $id: "AuditTrail",
    type: "object",
    additionalProperties: false,
    required: ["entries"],
    properties: { entries: { type: "array", items: { $ref: "AuditEntry" } } },
  },
  {
    $id: "DuplicateMatch",
    type: "object",
    additionalProperties: false,
    description:
      "A suspected or decided duplicate pair, named by the OTHER entry. This published component retains that top-level meaning for compatibility with an external compliance checker; the account-specific OwnedDuplicateMatch adds `yourListing` instead of repurposing these fields.",
    required: ["id", "title", "isPublic", "similarity", "matchedOn", "status", "detectedAt"],
    properties: {
      id: { type: "string", description: "The other entry's public id." },
      title: { type: "string" },
      isPublic: {
        type: "boolean",
        description:
          "True when the other entry is approved and listed, so a client may use its public detail route; false means an entitled workbench route is required.",
      },
      similarity: {
        type: ["number", "null"],
        description:
          "The lexical cosine similarity, unchanged in meaning and rounding. A pair caught by the overlap arm carries a similarity BELOW the lexical threshold by construction — `matchedOn` is what says which arm decided.",
      },
      matchedOn: {
        type: "array",
        items: {
          type: "string",
          enum: ["lexical", "overlap", "application_url", "operating_org"],
        },
        description:
          "Why this pair was flagged, as LABELS and never values: the first entry is the arm that decided (`lexical` = cosine similarity, `overlap` = length-corrected term overlap, which catches a shortened re-listing that cosine cannot), and anything after it is structural evidence corroborating the decision. Structural signals are recorded as explanation only and are deliberately barred from the decision itself. Computed from the live entries at read time, so it reflects them now. EMPTY on a pair recorded before these reasons existed.",
      },
      status: { type: "string", enum: ["suspected", "confirmed", "dismissed", "merged"] },
      detectedAt: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "DuplicateList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "DuplicateMatch" } } },
  },
  {
    $id: "OwnedDuplicateMatch",
    type: "object",
    additionalProperties: false,
    description:
      "An account-owned duplicate pair. `yourListing` identifies the side owned by the current account; all top-level match fields continue to name the OTHER entry. DuplicateMatch and DuplicateList are published public-API components documented that way and checked by an external compliance consumer, which is why this owner-specific component adds a field instead of changing their meaning.",
    required: [
      "id",
      "title",
      "isPublic",
      "similarity",
      "matchedOn",
      "status",
      "detectedAt",
      "yourListing",
    ],
    properties: {
      id: { type: "string", description: "The other entry's public id." },
      title: { type: "string" },
      isPublic: {
        type: "boolean",
        description:
          "True when the other entry is approved and listed; false when it is visible only through an entitled workbench route.",
      },
      similarity: { type: ["number", "null"] },
      matchedOn: {
        type: "array",
        items: {
          type: "string",
          enum: ["lexical", "overlap", "application_url", "operating_org"],
        },
        description:
          "Why this pair was flagged, as LABELS and never values: the first entry is the arm that decided (`lexical` = cosine similarity, `overlap` = length-corrected term overlap, which catches a shortened re-listing that cosine cannot), and anything after it is structural evidence corroborating the decision. Structural signals are recorded as explanation only and are deliberately barred from the decision itself. Computed from the live entries at read time, so it reflects them now. EMPTY on a pair recorded before these reasons existed.",
      },
      status: { type: "string", enum: ["suspected", "confirmed", "dismissed", "merged"] },
      detectedAt: { type: "string", format: "date-time" },
      yourListing: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
  {
    $id: "OwnedDuplicateList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "OwnedDuplicateMatch" } } },
  },
  {
    $id: "DuplicateNotificationPayload",
    type: "object",
    additionalProperties: false,
    description:
      "Structured duplicate facts, not presentation copy. `otherListing` is omitted unless that counterpart was approved and listed when the event was emitted; `decidedBy` is coarsened to a role and never identifies the deciding account.",
    required: ["pairId", "similarity", "yourListing", "action", "link", "decidedBy"],
    properties: {
      pairId: { type: "integer" },
      similarity: { type: ["number", "null"] },
      yourListing: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: { id: { type: "string" }, title: { type: "string" } },
      },
      otherListing: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: { id: { type: "string" }, title: { type: "string" } },
      },
      action: {
        type: "string",
        enum: ["review_match", "view_match", "view_survivor"],
      },
      link: { type: "string", pattern: "^/" },
      decidedBy: { type: ["string", "null"], enum: ["reviewer", null] },
    },
  },
  {
    $id: "Notification",
    type: "object",
    additionalProperties: false,
    description:
      "One account-scoped in-app notification. Email dispatch state is internal delivery telemetry and is not exposed here.",
    required: ["id", "kind", "subjectKind", "subjectId", "payload", "createdAt", "readAt"],
    properties: {
      id: { type: "integer" },
      kind: {
        type: "string",
        enum: [
          "duplicate_suspected",
          "duplicate_confirmed",
          "duplicate_dismissed",
          "duplicate_merged_away",
          "duplicate_absorbed",
          "duplicate_reopened",
        ],
      },
      subjectKind: { type: "string", enum: ["duplicate"] },
      subjectId: { type: "integer" },
      payload: { $ref: "DuplicateNotificationPayload" },
      createdAt: { type: "string", format: "date-time" },
      readAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  {
    $id: "NotificationList",
    type: "object",
    additionalProperties: false,
    required: ["items", "page", "limit", "total", "totalPages", "unreadCount"],
    properties: {
      items: { type: "array", items: { $ref: "Notification" } },
      page: { type: "integer" },
      limit: { type: "integer" },
      total: { type: "integer" },
      totalPages: { type: "integer" },
      unreadCount: { type: "integer" },
    },
  },
  {
    $id: "NotificationReadAll",
    type: "object",
    additionalProperties: false,
    required: ["markedRead", "unreadCount"],
    properties: {
      markedRead: { type: "integer" },
      unreadCount: { type: "integer", enum: [0] },
    },
  },
  {
    $id: "DuplicateSide",
    type: "object",
    additionalProperties: false,
    description:
      "One entry of a pair, as the REVIEW queue sees it — including the editorial state that decides which of the two may survive a merge.",
    required: ["id", "title", "reviewStatus", "isListed", "namespace", "mergedInto", "updatedAt"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
      isListed: { type: "boolean" },
      namespace: { type: ["string", "null"] },
      mergedInto: {
        type: ["string", "null"],
        description:
          "The survivor of an earlier merge. A merge target that carries this is refused — that is what prevents chains and, transitively, cycles.",
      },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "DuplicatePair",
    type: "object",
    additionalProperties: false,
    description:
      "A suspected or decided pair, both sides shown. `id` is the PAIR's own id — what /v1/review/duplicates/{id}/… names, never an opportunity id.",
    required: [
      "id",
      "status",
      "similarity",
      "signal",
      "matchedOn",
      "detectedAt",
      "reviewedAt",
      "left",
      "right",
    ],
    properties: {
      id: { type: "integer" },
      status: { type: "string", enum: ["suspected", "confirmed", "dismissed", "merged"] },
      similarity: { type: ["number", "null"] },
      signal: {
        type: ["object", "null"],
        additionalProperties: true,
        description:
          "The numeric decision inputs the detector recorded — `arm`, `lexical` (the cosine), `overlap` (cosine corrected by the norm ratio; an ESTIMATE of how much of the shorter entry's weighted vocabulary the longer one accounts for, NOT a containment and not bounded by 1) and `minTokens`. Null on a pair written before the column existed.",
      },
      matchedOn: {
        type: "array",
        items: {
          type: "string",
          enum: ["lexical", "overlap", "application_url", "operating_org"],
        },
        description:
          "Why this pair was flagged, as LABELS and never values: the first entry is the arm that decided (`lexical` = cosine similarity, `overlap` = length-corrected term overlap, which catches a shortened re-listing that cosine cannot), and anything after it is structural evidence corroborating the decision. Structural signals are recorded as explanation only and are deliberately barred from the decision itself. Computed from the live entries at read time, so it reflects them now. EMPTY on a pair recorded before these reasons existed.",
      },
      detectedAt: { type: "string", format: "date-time" },
      reviewedAt: { type: ["string", "null"], format: "date-time" },
      left: { $ref: "DuplicateSide" },
      right: { $ref: "DuplicateSide" },
    },
  },
  {
    $id: "DuplicatePairList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "DuplicatePair" } } },
  },
  {
    $id: "MergeResult",
    type: "object",
    additionalProperties: false,
    description:
      "The outcome of a merge. The loser is rejected, unlisted, archived and pointed at the survivor — its row is KEPT, because its public id may already be in an export, a feed or somebody's bookmarks.",
    required: ["pair", "survivorId", "mergedId", "copiedFields"],
    properties: {
      pair: { $ref: "DuplicatePair" },
      survivorId: { type: "string" },
      mergedId: { type: "string" },
      copiedFields: {
        type: "array",
        items: { type: "string" },
        description:
          "Which whitelisted fields were carried over. Empty by default — a merge copies nothing unless asked, and a copy that would leave the survivor invalid against the Standard rolls the whole merge back.",
      },
    },
  },
  {
    $id: "VerificationRun",
    type: "object",
    additionalProperties: false,
    description:
      "The most recent check of an entry's `applicationUrl`. A FAILED run is recorded too — `error` says why — because silence is indistinguishable from never having run.",
    required: [
      "runAt",
      "requestedUrl",
      "finalUrl",
      "httpStatus",
      "existsAtSource",
      "matched",
      "fieldDiff",
      "extracted",
      "snapshotSha256",
      "error",
    ],
    properties: {
      runAt: { type: "string", format: "date-time" },
      requestedUrl: { type: ["string", "null"] },
      finalUrl: { type: ["string", "null"] },
      httpStatus: { type: ["integer", "null"] },
      existsAtSource: { type: ["boolean", "null"] },
      matched: {
        type: ["boolean", "null"],
        description: "A low-bar anti-spam signal, not a fact-check. A reviewer still approves.",
      },
      fieldDiff: { type: ["object", "null"], additionalProperties: true },
      extracted: { type: ["object", "null"], additionalProperties: true },
      snapshotSha256: {
        type: ["string", "null"],
        description: "Digest of the RAW bytes that produced the stored extract.",
      },
      error: { type: ["string", "null"] },
    },
  },
  {
    $id: "InsightsTotals",
    type: "object",
    additionalProperties: false,
    description:
      "API reads and link-outs, NOT page views. The four counts are kept apart because a publisher's real question is whether anyone clicked through to apply, which a merged `views` cannot answer.",
    required: ["listViews", "detailViews", "sourceClicks", "applyClicks"],
    properties: {
      listViews: { type: "integer", description: "Appearances in a list response." },
      detailViews: { type: "integer", description: "Reads of the full record." },
      sourceClicks: {
        type: "integer",
        description: "Link-outs to `website` via /v1/r/{id}/source.",
      },
      applyClicks: {
        type: "integer",
        description: "Link-outs to `applicationUrl` via /v1/r/{id}/apply.",
      },
    },
  },
  {
    $id: "InsightsPoint",
    type: "object",
    additionalProperties: false,
    required: ["day", "listViews", "detailViews", "sourceClicks", "applyClicks"],
    properties: {
      day: { type: "string", description: "`YYYY-MM-DD`, UTC." },
      listViews: { type: "integer" },
      detailViews: { type: "integer" },
      sourceClicks: { type: "integer" },
      applyClicks: { type: "integer" },
    },
  },
  {
    $id: "InsightsSeries",
    type: "object",
    additionalProperties: false,
    description:
      "One entry's daily series. BEST-EFFORT: our own automation is excluded by name, crawlers and `DNT: 1` are dropped, and capture is buffered in memory and so crash-lossy. Days before today come from the nightly rollup; today is aggregated live from the raw events, so traffic from an hour ago is already here.",
    required: ["opportunityId", "title", "from", "to", "totals", "days"],
    properties: {
      opportunityId: { type: "string" },
      title: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      totals: { $ref: "InsightsTotals" },
      days: {
        type: "array",
        items: { $ref: "InsightsPoint" },
        description: "Zero-filled: a day with no traffic is a zero, never a gap in the series.",
      },
    },
  },
  {
    $id: "InsightsEntry",
    type: "object",
    additionalProperties: false,
    required: ["opportunityId", "title", "listViews", "detailViews", "sourceClicks", "applyClicks"],
    properties: {
      opportunityId: { type: "string" },
      title: { type: "string" },
      listViews: { type: "integer" },
      detailViews: { type: "integer" },
      sourceClicks: { type: "integer" },
      applyClicks: { type: "integer" },
    },
  },
  {
    $id: "InsightsSummary",
    type: "object",
    additionalProperties: false,
    description:
      "Every entry this account submitted or publishes, totalled over the window. Same best-effort caveat as InsightsSeries.",
    required: ["from", "to", "totals", "opportunities"],
    properties: {
      from: { type: "string" },
      to: { type: "string" },
      totals: { $ref: "InsightsTotals" },
      opportunities: { type: "array", items: { $ref: "InsightsEntry" } },
    },
  },
  {
    $id: "ClaimResult",
    type: "object",
    additionalProperties: false,
    description:
      "The outcome of claiming publisher ownership. `granted` transferred it immediately (the organization is verified and OPERATES the entry); `queued` filed a claim for review.",
    required: ["outcome", "claimId", "opportunityId", "organizationSlug", "message"],
    properties: {
      outcome: { type: "string", enum: ["granted", "queued", "unchanged"] },
      claimId: { type: ["integer", "null"] },
      opportunityId: { type: "string" },
      organizationSlug: { type: "string" },
      message: {
        type: "string",
        description:
          "What the outcome means for future writes — in particular, a grant on an UNVERIFIED organization transfers ownership without unlocking auto-approval.",
      },
    },
  },
  {
    $id: "ClaimSummary",
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "opportunityId",
      "opportunityTitle",
      "organizationSlug",
      "organizationVerified",
      "claimedBy",
      "claimedByAccountId",
      "status",
      "note",
      "createdAt",
      "decidedAt",
    ],
    properties: {
      id: { type: "integer" },
      opportunityId: { type: "string" },
      opportunityTitle: { type: "string" },
      organizationSlug: { type: "string" },
      organizationVerified: { type: "boolean" },
      claimedBy: { type: "string" },
      claimedByAccountId: {
        type: ["integer", "null"],
        description: "The stable claimant identity used to disclose self-review.",
      },
      status: { type: "string", enum: ["pending", "approved", "rejected", "withdrawn"] },
      note: { type: ["string", "null"] },
      createdAt: { type: "string", format: "date-time" },
      decidedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  {
    $id: "ClaimList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "ClaimSummary" } } },
  },
  {
    $id: "Publisher",
    type: "object",
    additionalProperties: false,
    description:
      "A VERIFIED organization — the namespace a write can auto-approve into. Verification is a publishing relationship, not an attribute of the issuer, so the directory holds many organizations that are not here.",
    required: ["slug", "name", "description", "website", "logoUrl", "ecosystems", "verifiedAt"],
    properties: {
      slug: {
        type: "string",
        description: "The namespace. Public ids under it read `<slug>:<local>`.",
      },
      name: { type: "string" },
      description: { type: ["string", "null"] },
      website: { type: ["string", "null"] },
      logoUrl: { type: ["string", "null"] },
      ecosystems: { type: "array", items: { type: "string" } },
      verifiedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  {
    $id: "PublisherList",
    type: "object",
    additionalProperties: false,
    required: ["items", "total"],
    properties: {
      items: { type: "array", items: { $ref: "Publisher" } },
      total: { type: "integer" },
    },
  },
  {
    $id: "MeMembership",
    type: "object",
    additionalProperties: false,
    required: ["slug", "name", "role", "verified"],
    properties: {
      slug: { type: "string" },
      name: { type: "string" },
      role: { type: "string", enum: ["owner", "admin", "publisher"] },
      verified: {
        type: "boolean",
        description: "Only a membership on a VERIFIED organization auto-approves a write.",
      },
    },
  },
  {
    $id: "Me",
    type: "object",
    additionalProperties: false,
    description:
      "The authenticated account, as resolved for THIS request. `credentialKind` is part of the answer, not decoration: an API key never manages keys, changes identity, reviews or administers, whatever role the account holds.",
    required: [
      "accountId",
      "handle",
      "displayName",
      "email",
      "role",
      "directCreate",
      "credentialKind",
      "scopes",
      "memberships",
      "canManageKeys",
      "canReview",
      "canAdmin",
      "createdAt",
    ],
    properties: {
      accountId: { type: "integer" },
      handle: {
        type: ["string", "null"],
        description: "The public identifier attribution uses. Null until it is chosen.",
      },
      displayName: { type: ["string", "null"] },
      email: {
        type: ["string", "null"],
        description:
          "The verified address this account signs in with. Null when the request presented an API key, which identifies an account without identifying a session.",
      },
      role: { type: "string", enum: ["submitter", "reviewer", "admin"] },
      directCreate: { type: "boolean" },
      credentialKind: { type: "string", enum: ["session", "api_key"] },
      scopes: { type: "array", items: { type: "string" } },
      memberships: { type: "array", items: { $ref: "MeMembership" } },
      canManageKeys: { type: "boolean" },
      canReview: { type: "boolean" },
      canAdmin: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "ApiKey",
    type: "object",
    additionalProperties: false,
    description:
      "An API key WITHOUT its secret. The secret exists once, at mint, and is never returned again.",
    required: [
      "id",
      "name",
      "keyPrefix",
      "scopes",
      "createdAt",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
    ],
    properties: {
      id: { type: "integer" },
      name: { type: ["string", "null"] },
      keyPrefix: {
        type: "string",
        description: "The public 8-character identifier. Not a secret; it is how a key is named.",
      },
      scopes: { type: "array", items: { type: "string", enum: ["read", "write", "publish"] } },
      createdAt: { type: "string", format: "date-time" },
      lastUsedAt: {
        type: ["string", "null"],
        format: "date-time",
        description: "Refreshed at most once every five minutes, best-effort.",
      },
      expiresAt: { type: ["string", "null"], format: "date-time" },
      revokedAt: {
        type: ["string", "null"],
        format: "date-time",
        description: "Revocation is soft, so an audit row naming this key always resolves.",
      },
    },
  },
  {
    $id: "ApiKeyList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "ApiKey" } } },
  },
  {
    $id: "ApiKeyCreated",
    type: "object",
    additionalProperties: false,
    description:
      "A freshly minted key. `token` is shown EXACTLY ONCE — it is not stored and cannot be recovered.",
    required: ["key", "token"],
    properties: {
      key: { $ref: "ApiKey" },
      token: { type: "string", description: "The full credential: `rfph_<prefix>_<secret>`." },
    },
  },
  {
    $id: "ManagedOpportunity",
    type: "object",
    additionalProperties: false,
    description:
      "The editorial projection of an entry — what an owner sees on their own listings and what a reviewer sees in the queue, including entries the public reads cannot see.",
    required: [
      "id",
      "title",
      "fundingType",
      "status",
      "reviewStatus",
      "isListed",
      "namespace",
      "submittedBy",
      "submittedByAccountId",
      "mergedInto",
      "lastDecision",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      fundingType: { type: "string" },
      status: { type: "string" },
      reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
      isListed: { type: "boolean" },
      namespace: { type: ["string", "null"] },
      submittedBy: { type: ["string", "null"] },
      submittedByAccountId: {
        type: ["integer", "null"],
        description: "The stable submitting-account identity used to disclose self-review.",
      },
      mergedInto: {
        type: ["object", "null"],
        additionalProperties: false,
        description:
          "The survivor of a terminal merge. Its id remains visible to the owner through the merge audit; its current title is present only while the survivor is approved and listed. Null for an active or ordinary managed row.",
        required: ["id", "title"],
        properties: {
          id: { type: "string" },
          title: { type: ["string", "null"] },
        },
      },
      lastDecision: {
        type: ["object", "null"],
        additionalProperties: false,
        description:
          "The newest approve/reject recorded against this entry, read from the audit trail. Null until somebody decides. `reason` is whatever the decider wrote — including the server's own reason for an automatic approval — and is null when none was given.",
        required: ["action", "reason", "at"],
        properties: {
          action: { type: "string", enum: ["approve", "reject"] },
          reason: { type: ["string", "null"] },
          at: { type: "string", format: "date-time" },
        },
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "ManagedOpportunityList",
    type: "object",
    additionalProperties: false,
    required: ["items", "page", "limit", "total", "totalPages"],
    properties: {
      items: { type: "array", items: { $ref: "ManagedOpportunity" } },
      page: { type: "integer" },
      limit: { type: "integer" },
      total: { type: "integer" },
      totalPages: { type: "integer" },
    },
  },
  {
    $id: "ReviewDecision",
    type: "object",
    additionalProperties: false,
    required: ["id", "reviewStatus", "isListed"],
    properties: {
      id: { type: "string" },
      reviewStatus: { type: "string", enum: ["pending", "approved", "rejected"] },
      isListed: { type: "boolean" },
    },
  },
  {
    $id: "AccountSummary",
    type: "object",
    additionalProperties: false,
    description:
      "An account as the review and admin screens see it. Never carries the provider subject; privileged directory searches additionally carry email.",
    required: ["id", "handle", "displayName", "globalRole", "directCreate", "createdAt"],
    properties: {
      id: { type: "integer" },
      handle: { type: ["string", "null"] },
      displayName: { type: ["string", "null"] },
      email: { type: ["string", "null"], format: "email" },
      globalRole: { type: "string", enum: ["submitter", "reviewer", "admin"] },
      directCreate: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
    },
  },
  {
    $id: "AccountList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "AccountSummary" } } },
  },
  {
    $id: "OrganizationSummary",
    type: "object",
    additionalProperties: false,
    required: ["slug", "name", "verified", "verifiedAt", "website", "ecosystems", "memberCount"],
    properties: {
      slug: { type: "string" },
      name: { type: "string" },
      verified: { type: "boolean" },
      verifiedAt: { type: ["string", "null"], format: "date-time" },
      website: { type: ["string", "null"] },
      ecosystems: { type: "array", items: { type: "string" } },
      memberCount: { type: "integer" },
    },
  },
  {
    $id: "OrganizationList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "OrganizationSummary" } } },
  },
  {
    $id: "MembershipResult",
    type: "object",
    additionalProperties: false,
    required: ["organizationSlug", "accountId", "role", "member"],
    properties: {
      organizationSlug: { type: "string" },
      accountId: { type: "integer" },
      role: { type: ["string", "null"], enum: ["owner", "admin", "publisher", null] },
      member: { type: "boolean", description: "False when the membership was revoked." },
    },
  },
  {
    $id: "MembershipInvite",
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "organizationSlug",
      "email",
      "role",
      "invitedBy",
      "createdAt",
      "acceptedAt",
      "acceptedAccountId",
    ],
    properties: {
      id: { type: "integer" },
      organizationSlug: { type: "string" },
      email: { type: "string", format: "email" },
      role: { type: "string", enum: ["owner", "admin", "publisher"] },
      invitedBy: { type: "integer" },
      createdAt: { type: "string", format: "date-time" },
      acceptedAt: { type: ["string", "null"], format: "date-time" },
      acceptedAccountId: { type: ["integer", "null"] },
    },
  },
  {
    $id: "MembershipInviteList",
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { $ref: "MembershipInvite" } } },
  },
  {
    $id: "JobRunResult",
    type: "object",
    additionalProperties: false,
    description:
      "One scheduled maintenance run. `shape` is `cursor` when the run retires its own selection (so it may repeat while it is making progress) and `sweep` when it reprocesses a fixed window by design, in which case `remaining` is always 0. `skipped` says the run correctly did nothing: `locked` when another run of the same job held the database advisory lock, or a sentence naming the feature that is not configured.",
    required: ["job", "shape", "processed", "remaining", "passes", "elapsedMs"],
    properties: {
      job: { type: "string" },
      shape: { type: "string", enum: ["cursor", "sweep"] },
      processed: { type: "integer", description: "Rows this invocation changed." },
      remaining: { type: "integer" },
      skipped: { type: "string" },
      passes: { type: "integer" },
      elapsedMs: { type: "integer" },
      details: {
        type: "object",
        additionalProperties: { type: "integer" },
        description: "Per-job counters. The members vary by job and are not part of the contract.",
      },
    },
  },
  {
    $id: "MergedOpportunityErrorResponse",
    type: "object",
    additionalProperties: false,
    description:
      "A public id that resolved when it was merged. The response remains a 404; clients may load the currently public survivor named here.",
    required: ["error", "mergedInto"],
    properties: {
      error: { type: "string", const: "opportunity_merged" },
      mergedInto: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
      },
    },
  },
  {
    $id: "ErrorResponse",
    type: "object",
    additionalProperties: false,
    required: ["error", "message"],
    properties: {
      error: { type: "string", description: "Stable machine-readable error code (snake_case)." },
      message: { type: "string", description: "Human-readable detail." },
    },
  },
  {
    $id: "RateLimitedResponse",
    type: "object",
    additionalProperties: false,
    description:
      "The request was refused for exceeding this operation's ceiling. The STATUS is the discriminator — `error` is the generic client-error code, because the limiter's refusal is raised before any handler and carries no domain code of its own.",
    required: ["error", "message"],
    properties: {
      error: { type: "string", enum: ["client_error"] },
      message: { type: "string" },
    },
  },
];

/** The `429` half of every metered operation's contract, referenced so the four header schemas
 * cannot drift between them. */
export const RATE_LIMITED = {
  $ref: "RateLimitedResponse#",
  description:
    "Rate limit exceeded. Metered per credential-holder (`acct:<id>`), or per client address for a request that proved no credential. Wait `Retry-After` seconds.",
  // @fastify/swagger adds the `schema` wrapper itself; a nested one publishes `schema.schema`.
  headers: {
    "retry-after": {
      type: "integer",
      minimum: 1,
      description: "Whole seconds until this bucket's window resets.",
    },
    "x-ratelimit-limit": {
      type: "integer",
      minimum: 0,
      description: "This operation's ceiling for the window.",
    },
    "x-ratelimit-remaining": {
      type: "integer",
      minimum: 0,
      description: "Requests left in the window. `0` on a 429.",
    },
    "x-ratelimit-reset": {
      type: "integer",
      minimum: 0,
      description: "Whole seconds until the window resets.",
    },
  },
} as const;
