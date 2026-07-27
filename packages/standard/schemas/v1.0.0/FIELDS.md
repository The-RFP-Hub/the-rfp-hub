# RFP Hub Standard v1.0.0 — Field Reference

> **Maturity: `draft`.** This version was **re-cut in place on 2026-07-27** — documents published
> under the string `1.0.0` before that date do not validate against it. See
> [`STATUS.md`](./STATUS.md), the field-mapping table in
> [`CHANGELOG.md`](../../CHANGELOG.md) and
> [`adr/0001`](../../../../adr/0001-recut-v1.0.0-in-place.md).

The **RFP Hub Standard** is a canonical, ecosystem-neutral representation of a funding
opportunity in the Ethereum ecosystem. The normative artifact is
[`opportunity.schema.json`](./opportunity.schema.json) (JSON Schema, draft 2020-12).

**This document is informative.** It explains the fields, the conventions the schema cannot
enforce, and the lifecycle semantics — but where its prose disagrees with the schema, **the
schema wins**, and this file gets corrected. See [`NORMATIVE.md`](../../NORMATIVE.md) for the
full normative/informative split and what that means for the release cycle.

- **License:** CC0 1.0 (the standard and its docs are public domain).
- **Spec version:** `1.0.0` — every entry carries `specVersion: "1.0.0"` exactly.
- **`$id`:** `https://raw.githubusercontent.com/The-RFP-Hub/the-rfp-hub/main/packages/standard/schemas/v1.0.0/opportunity.schema.json`
  — ⚠️ **provisional.** The project has no canonical domain yet, so the identifier points at the
  file in the repository, where it dereferences to exactly these bytes (served as `text/plain`).
  It is stamped from [`spec.config.json`](../../spec.config.json); adopting a domain is one edit
  there. See [`STATUS.md`](./STATUS.md#known-issues-in-this-version).

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted
as described in BCP 14 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all
capitals, as shown here.

Several requirements in this standard are **stated but not schema-enforceable** — they cross
object boundaries, or they describe an ingestion policy rather than a document shape. Those are
written as MUST here and are checked by the advisory tier of `rfphub-validate`, not by JSON
Schema. Where that is the case, this document says so at the point of the rule.

## Scope

The Hub is **ETH-scoped**, not a multi-ecosystem catch-all. It does not attempt to absorb
Solana/Cosmos/other non-ETH ecosystems. However, `ecosystems` is an **open, extensible
list — not a closed enum** — so the Ethereum L1 plus L2s and ETH-adjacent ecosystems
(Optimism, Base, Arbitrum, Polygon, Scroll, zkSync, Linea, OP Stack, Celo, …) are all
first-class. `ecosystems` and `networks` are deliberately **not** registry-governed: a registry
over a list of chain names reads as an allowed-values list however carefully the normative
document words it, and it would put a review step in front of a newly launched chain for no
interoperability gain. Write the ecosystem's usual name.

## Design principles

1. **Source-agnostic.** The standard carries no source-system internal fields (on-chain ids,
   internal primary keys, vendor-specific flags). Such data, if needed, goes under `extensions`
   with namespaced keys (e.g. `mysource.internalId`). This keeps the standard neutral and
   forkable — it isn't coupled to any one aggregator's schema.
2. **Provenance is recorded, not validated.** `source` is a required object, but **every field
   inside it is optional** — `"source": {}` validates. There is no required source URL and no
   required provenance field of any kind. "Every entry is traceable to an original posting" is
   therefore asserted by **ingestion policy**, not by schema validation: the Hub's ingestion
   layer always sets `source.ingestedVia` server-side and records `submittedBy`/`submittedAt`,
   and a publisher's own pipeline is expected to do the equivalent. A validator will not catch a
   record with empty provenance, because a validator is the wrong place to catch it. *(This
   replaces the earlier principle "every entry MUST carry a `source.url`" — that field no longer
   exists; see the field-mapping table in [`CHANGELOG.md`](../../CHANGELOG.md).)*
3. **Closed core, open edges.** The top-level object and all type-specific blocks are
   `additionalProperties: false`, with three exceptions carved out for self-identification
   (`$schema`, `@context`, `@type`). Arbitrary publisher/integrator data goes in the free-form
   `extensions` object. Where a field is deliberately open **and its values need to be
   comparable across publishers** — `eligibility` keys, `deadlines[].label`,
   `grant.programModel` — the **schema stays permissive and a [registry](../../registries/)
   fixes what each value means**. Registered values are normative; unregistered values remain
   valid and raise a warning, never an error. `ecosystems` and `networks` are open with **no**
   registry, deliberately: see [Scope](#scope).
4. **Alignment.** Concepts align with DAOIP-5 (Grants Metadata) and schema.org/Grant where
   practical, without inheriting their full surface area. See [CROSSWALK.md](./CROSSWALK.md).

All date-time fields are **RFC 3339 / ISO 8601** strings.

---

## Field reference

The tables below are **generated from the schema** by `pnpm codegen`; `pnpm codegen:check`
fails CI if they drift. Do not edit them by hand — edit the schema's `description` and
regenerate. The **Registry** column links the open vocabulary that governs a field's *values*
where one exists.

<!-- BEGIN generated:fields -->

### Top-level fields

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `$schema` | string(uri) |  | Optional self-identification: the URL of the RFP Hub schema this document claims to conform to. Permitted so a generic validator can discover the contract from the instance alone. Ignored by validation — naming a different schema here does not change which schema the document is validated against. | — |
| `@context` | string \| object \| any[] |  | Optional JSON-LD context: a URL, an inline context object, or an array of either. Permitted so an instance can be consumed as linked data. Ignored by validation — the standard makes no claim about its contents. | — |
| `@type` | string \| any[] |  | Optional JSON-LD type, or an array of types. Permitted so an instance can be consumed as linked data; ignored by validation. | — |
| `specVersion` | `1.0.0` | ✅ | The RFP Hub Standard version this entry conforms to. Fixed at 1.0.0 for this schema. Consumers use it to select the correct validator. | — |
| `id` | string, ≤128, `^[A-Za-z0-9._:-]+$` | ✅ | Stable, unique identifier for the opportunity within the Hub. Immutable once assigned. A namespaced form is recommended but not required. | — |
| `fundingType` | `grant` \| `hackathon` \| `bounty` \| `accelerator` \| `vc_fund` \| `rfp` | ✅ | The kind of funding opportunity, and the structural discriminator of the standard. Every entry carries a type-specific object under a key equal to this value ('hackathon' → a 'hackathon' object, 'vc_fund' → a 'vc_fund' object), so consumers can always read `opportunity[opportunity.fundingType]`. The matching block is required and no other type block may be present; for grants the block may be empty. | — |
| `title` | string, ≤300 | ✅ | Human-readable name of the opportunity. | — |
| `description` | string | ✅ | Full description of the opportunity. Markdown is permitted; consumers are advised to treat it as untrusted and sanitise before rendering. | — |
| `summary` | string\|null, ≤500 |  | Optional short teaser (roughly one or two sentences) for list and card views. | — |
| `status` | `upcoming` \| `open` \| `closed` \| `archived` | ✅ | Lifecycle status of the opportunity. 'upcoming' = announced but not yet accepting applications, and also the value for a pre-open posting — there is no 'draft' status; 'open' = currently accepting; 'closed' = no longer accepting; 'archived' = withdrawn or retired. Editorial and review state (pending, rejected) is not represented here — it is server-side metadata. | — |
| `sponsoringOrganizations` | [`organization`](#organization)[], min 1 | ✅ | The organisations issuing or backing the opportunity. Array order is semantic: entry 0 is the primary organisation and the one to display. This is the issuer or backer, not necessarily the source of funds — for donor-funded models the money's origin is deliberately not modelled, and the party running the process belongs in operatingOrganizations instead. | — |
| `operatingOrganizations` | [`organization`](#organization)[] |  | The organisations that actually run intake and process — for example an operator running the application funnel on a funder's behalf. May be absent or empty when the sponsor also operates. | — |
| `source` | [`provenance`](#provenance) | ✅ | Provenance of this entry. Required as an object, but every field inside it is optional, so `"source": {}` validates. Provenance completeness is a data-quality and ingestion-policy concern rather than a schema constraint. | — |
| `ecosystems` | string[], unique |  | Ethereum-family ecosystems this opportunity targets. The RFP Hub is ETH-scoped, but this is an open, extensible list — not a closed enum, and deliberately not registry-governed either — so L2s and ETH-adjacent ecosystems are first-class and a newly launched one needs no process. | — |
| `networks` | string[], unique |  | Specific networks or chains the funding is denominated on or deployed to. A plain open list, deliberately not registry-governed, so a newly launched chain is expressible immediately. | — |
| `categories` | string[], unique |  | Topical categories. Free text. | — |
| `tags` | string[], unique |  | Free-form tags for search and faceting. | — |
| `eligibility` | object<string, string> |  | Open key-value map of eligibility criteria. Publishers choose their own keys and write plain-string values; there are no fixed or required keys. Conventional keys (stage, geography, jurisdiction, sector, entityType, compliance) are published in registries/eligibility-keys.json — using them keeps the field comparable across publishers, and unregistered keys stay valid. | [`eligibility-keys`](../../registries/eligibility-keys.json) |
| `prerequisites` | string\|null |  | Free text describing what a proposal must contain to be considered — track record, approach, milestone plan, disclosures. Distinct from rfp.requirements, which describes what the work must deliver. | — |
| `resourceLinks` | string\|null |  | A single free-form string of supporting links and references — guidelines, past rounds, forum threads, original postings. Deliberately one string rather than an array of URIs, because publishers paste what they have. | — |
| `serviceAgreement` | string\|null |  | Free text describing how a service-agreement arrangement works. Valid on any fundingType — an rfp or grant carrying it reads as a long-term service engagement. Presence of the field is the signal; duration and renewal live in the text if they matter. Not filterable or facetable, by design. **(provisional)** | — |
| `applicationUrl` | string(uri)\|null |  | URL where applicants submit or apply — the only URL that points at the opportunity itself, and therefore the only link-back target. It may carry whatever the submission channel is, including a forum thread when no portal exists; the URL's kind is not typed. Clarifications go in description. | — |
| `website` | string(uri)\|null |  | Primary website for the opportunity or program. | — |
| `logoUrl` | string(uri)\|null |  | URL of the program or organisation logo image. | — |
| `bannerUrl` | string(uri)\|null |  | URL of a banner or hero image. | — |
| `socialLinks` | [`socialLinks`](#sociallinks) |  | Social and community links for the opportunity or program. | — |
| `funding` | [`funding`](#funding) |  | Program-level funding envelope: single currency, total budget, amount committed to date, and the per-award range. | — |
| `milestones` | [`milestone`](#milestone)[] |  | Optional milestone sequence, valid on any fundingType. Array order is the milestone sequence — there is no order or index field. Milestone-based payment is expressed by this array together with grant.milestoneBased; there is no separate payment-schedule concept. **(provisional)** | — |
| `opensAt` | string(date-time)\|null |  | RFC 3339 timestamp when applications open. | — |
| `deadlines` | [`deadline`](#deadline)[], unique |  | All deadlines and event boundaries for the opportunity, each either a fixed date or rolling, distinguished by label. Consumers should select by label rather than by array position: the first entry may be a hackathon's start date rather than its application deadline. Conventional labels are published in registries/deadline-labels.json. (Selection-by-label is a consumer convention, not schema-enforceable; see FIELDS.md.) | — |
| `postedAt` | string(date-time)\|null |  | RFC 3339 timestamp when the opportunity was first publicly announced at the source. | — |
| `createdAt` | string(date-time)\|null |  | RFC 3339 timestamp when this entry was created in the Hub. | — |
| `updatedAt` | string(date-time)\|null |  | RFC 3339 timestamp when this entry was last modified in the Hub. | — |
| `grant` | [`grant`](#grant) | cond. | Grant-specific fields. Required, possibly as an empty object, when fundingType is 'grant'; forbidden otherwise. | — |
| `hackathon` | [`hackathon`](#hackathon) | cond. | Hackathon-specific fields. Required when fundingType is 'hackathon'; forbidden otherwise. | — |
| `bounty` | [`bounty`](#bounty) | cond. | Bounty-specific fields. Required when fundingType is 'bounty'; forbidden otherwise. | — |
| `accelerator` | [`accelerator`](#accelerator) | cond. | Accelerator-specific fields. Required when fundingType is 'accelerator'; forbidden otherwise. | — |
| `vc_fund` | [`vcFund`](#vcfund) | cond. | VC-fund-specific fields. Required when fundingType is 'vc_fund'; forbidden otherwise. | — |
| `rfp` | [`rfp`](#rfp) | cond. | RFP-specific fields. Required when fundingType is 'rfp'; forbidden otherwise. | — |
| `extensions` | object |  | Namespace for publisher- or integrator-specific data not covered by the standard. Keys are conventionally namespaced, for example 'mysource.internalId'. Contents are not validated by this schema. | — |

### `organization`

An organisation sponsoring or operating the opportunity. Embedded on an opportunity as a descriptive summary; the same shape is the standalone Organization directory record.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `name` | string, ≤256 | ✅ | Display name of the organisation. | — |
| `slug` | string\|null, `^[a-z0-9-]+$` |  | Lowercase URL-safe identifier, and also the organisation's namespace. | — |
| `type` | `foundation` \| `dao` \| `company` \| `protocol` \| `program` \| `individual` \| `other`\|null |  | Kind of entity. | — |
| `description` | string\|null |  | Short description of the organisation. | — |
| `website` | string(uri)\|null |  | The organisation's primary website. | — |
| `logoUrl` | string(uri)\|null |  | URL of the organisation's logo image. | — |
| `bannerUrl` | string(uri)\|null |  | URL of the organisation's banner or hero image. | — |
| `socialLinks` | [`socialLinks`](#sociallinks) |  | Social and community links for the organisation. | — |
| `ecosystems` | string[], unique |  | Ethereum-family ecosystems the organisation operates in. Same open list as the top-level field. | — |
| `contacts` | [`contact`](#contact)[] |  | Named contact routes into the organisation. Optional, and every field of every entry is optional too. | — |

### `contact`

A named contact route into the organisation. Every property is optional and there is no minimum-one-identifier constraint, so `{}` validates — deliberately, because not every publisher can or will name a person.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `name` | string\|null |  | The person's name. | — |
| `role` | string\|null |  | Role in the program. | — |
| `telegram` | string\|null |  | Telegram handle. A handle rather than a URL — unlike socialLinks.telegram, which is a link. | — |
| `email` | string(email)\|null |  | Email address. | — |

### `provenance`

How this entry reached the Hub and when it was last checked. Every field is optional, so `{}` validates. There is no source URL: link-back to the opportunity runs through the top-level applicationUrl alone.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `publisher` | string\|null |  | Namespace — an organisation slug — this entry was published under. Auto-approval requires the publishing account to be a member of this verified org. May differ from the sponsoring organisation. | — |
| `submittedBy` | string\|null |  | Who submitted or published this entry: a public handle, an organisation slug, or 'community' for anonymous community submissions. The internal account identity is never exposed. This is the attribution carrier for data-partner credit. | — |
| `submittedAt` | string(date-time)\|null |  | RFC 3339 timestamp of when the entry was submitted or published to the Hub. Pairs with submittedBy. | — |
| `ingestedVia` | `publisher_api` \| `submission` \| `scrape` \| `import` \| `outbox`\|null |  | How this entry entered the Hub. 'outbox' is a one-way push from an upstream source system's outbox; 'import' is a backfill or seed import. Always set server-side by the ingestion layer. | — |
| `originalId` | string\|null |  | Identifier of this opportunity in the source system. | — |
| `verifiedAgainstSource` | boolean\|null |  | Whether the entry's fields were verified against the live opportunity by the verification-assist job. null means not yet checked. | — |
| `verifiedAt` | string(date-time)\|null |  | RFC 3339 timestamp of the last verification. Record-level only — there is no per-field freshness. | — |
| `snapshotUrl` | string(uri)\|null |  | IPFS or archived snapshot of the opportunity taken at verification time. | — |

### `socialLinks`

Social and community links. Every value is a full URL, not a handle.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `twitter` | string(uri)\|null |  | Link to the X/Twitter profile. | — |
| `discord` | string(uri)\|null |  | Discord server invite or channel link. | — |
| `github` | string(uri)\|null |  | Link to the GitHub organisation or repository. | — |
| `telegram` | string(uri)\|null |  | Link to the Telegram group or channel. | — |
| `farcaster` | string(uri)\|null |  | Link to the Farcaster profile or channel. | — |
| `forum` | string(uri)\|null |  | Link to the governance or community forum. | — |
| `blog` | string(uri)\|null |  | Link to the blog or announcements feed. | — |

### `funding`

The program-level funding envelope. Single-currency by design, and that rule is scoped to this envelope only: bounty.reward, hackathon.prizes[].currency and accelerator.funding each keep their own currency, because a prize pool may legitimately be denominated differently from the program budget. 'Remaining' is derived at the consumer layer as budget minus allocated, and never stored.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `currency` | string\|null, ≤16 |  | ISO 4217 code or token symbol for the amounts below, and for milestones[].amount. | — |
| `budget` | number\|null, ≥0 |  | Total program budget in major units. | — |
| `allocated` | number\|null, ≥0 |  | Amount committed to date in major units — committed, not necessarily disbursed. Disbursement and delivery are not modelled. | — |
| `minAward` | number\|null, ≥0 |  | Minimum individual award in major units. | — |
| `maxAward` | number\|null, ≥0 |  | Maximum individual award in major units. | — |

### `monetaryAmount`

A single amount with its own currency, used where a sub-block is denominated independently of the program envelope.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `amount` | number, ≥0 | ✅ | Amount in major units of the currency, so 2000000 means 2,000,000 USD rather than cents. | — |
| `currency` | string, ≤16 | ✅ | ISO 4217 fiat code such as USD or EUR, or a token symbol such as ETH, OP or USDC. | — |

### `amountRange`

A lower and upper bound with a shared currency. Either bound may be absent, expressing an open-ended range.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `min` | number\|null, ≥0 |  | Lower bound in major units. | — |
| `max` | number\|null, ≥0 |  | Upper bound in major units. | — |
| `currency` | string\|null, ≤16 |  | ISO 4217 code or token symbol for both bounds. | — |

### `deadline`

A single deadline or event boundary. A 'fixed' entry carries a date; 'rolling' means applications are accepted continuously.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `type` | `fixed` \| `rolling` | ✅ | Whether this deadline is a fixed point in time or an open-ended rolling window. | — |
| `date` | string(date-time)\|null |  | RFC 3339 timestamp. Required and non-null when type is 'fixed', enforced by the if/then below; meaningless, and normally omitted, when type is 'rolling'. | — |
| `label` | string\|null, ≤120 |  | What this deadline is for. Free text; conventional values are published in registries/deadline-labels.json. This is how a consumer tells an application deadline from an event boundary. | [`deadline-labels`](../../registries/deadline-labels.json) |

### `milestone`

One milestone in an opportunity's milestone sequence. Every property is optional — a publisher may list titles with no amounts, or amounts with no criteria. There is no date field: where a publisher has a due date, it goes into `criteria` as free text.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `title` | string\|null |  | Short name of the milestone. | — |
| `amount` | number\|null, ≥0 |  | Payment for this milestone in major units, denominated in the top-level funding.currency. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and funding.currency is absent. | — |
| `criteria` | string\|null |  | Free-text acceptance criteria, including any due date. | — |

### `grant`

Grant-specific attributes not covered by the core fields. May be an empty object, because core funding and date fields live at the top level.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingMechanisms` | (`retroactive` \| `proactive` \| `streaming` \| `quadratic` \| `matching` \| `other`)[], unique |  | How funds are allocated. An array because mechanisms co-occur: a funder can offer a fixed grant and a matching grant in the same program. | — |
| `programModel` | string\|null |  | The operating model of the program, as distinct from the funding instrument. An open list rather than a closed enum — conventional values are published in registries/program-models.json, and a publisher's own vocabulary is valid without a schema change. **(provisional)** | [`program-models`](../../registries/program-models.json) |
| `milestoneBased` | boolean\|null |  | Whether disbursement is tied to milestones. Pairs with the top-level milestones array. | — |
| `recurring` | boolean\|null |  | Whether the program runs in recurring rounds or seasons. | — |

### `hackathon`

Hackathon-specific attributes. All dates — registration, submission, event start and event end — live in the shared top-level deadlines array, distinguished by label.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `location` | string\|null |  | Physical location, or null for a fully online event. | — |
| `online` | boolean\|null |  | Whether the event is also, or only, held online. | — |
| `tracks` | string[], unique |  | Named tracks or themes participants can build against. | — |
| `prizes` | [`prize`](#prize)[] |  | The prize pool, one entry per prize. Each prize carries its own currency. | — |
| `teamSize` | [`teamSize`](#teamsize) |  | Permitted team size range. | — |

### `prize`

A single hackathon prize, optionally attributed to a track.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `track` | string\|null |  | Track this prize belongs to, where prizes are tracked separately. | — |
| `amount` | number, ≥0 | ✅ | Prize amount in major units. | — |
| `currency` | string, ≤16 | ✅ | ISO 4217 code or token symbol for this prize. | — |

### `teamSize`

Permitted team size, as an inclusive range. Either bound may be absent.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `min` | integer\|null, ≥1 |  | Minimum number of team members. | — |
| `max` | integer\|null, ≥1 |  | Maximum number of team members. | — |

### `bounty`

Bounty-specific attributes. A bounty is a single scoped task with a stated reward, so the reward is the one required field.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `reward` | [`monetaryAmount`](#monetaryamount) | ✅ | The reward paid on completion. Carries its own currency. | — |
| `difficulty` | `beginner` \| `intermediate` \| `advanced`\|null |  | Self-assessed difficulty, as a hint to applicants. | — |
| `skills` | string[], unique |  | Skills the task calls for. Free text. | — |
| `platform` | string\|null |  | Platform hosting the bounty. | — |

### `accelerator`

Accelerator-specific attributes. The application deadline lives in the shared top-level deadlines array with label 'application'.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `programDurationWeeks` | integer\|null, ≥0 |  | Length of the program in weeks. | — |
| `batchSize` | integer\|null, ≥0 |  | Number of teams accepted per cohort. | — |
| `equity` | string\|null |  | Equity taken, expressed as a string because programs state it in incomparable ways. | — |
| `funding` | [`monetaryAmount`](#monetaryamount) |  | Investment or stipend offered per team. Carries its own currency. | — |
| `stage` | `pre-seed` \| `seed` \| `series-a`\|null |  | Company stage the program targets. | — |
| `location` | string\|null |  | Physical location, or null for a fully remote program. | — |
| `online` | boolean\|null |  | Whether the program is also, or only, run remotely. | — |

### `vcFund`

Venture-fund-specific attributes. A fund is an ongoing source of capital rather than a round, so it carries no deadline of its own.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `checkSize` | [`amountRange`](#amountrange) |  | Typical investment size, as a range. | — |
| `stages` | (`pre-seed` \| `seed` \| `series-a` \| `series-b+` \| `growth`)[], unique |  | Investment stages the fund participates in. | — |
| `thesis` | string\|null |  | Investment thesis, in the fund's own words. | — |
| `portfolio` | string[], unique |  | Named portfolio companies, where the fund publishes them. | — |
| `contactMethod` | `email` \| `form` \| `intro-only`\|null |  | How the fund prefers to be approached. 'intro-only' means a warm introduction is required. | — |
| `activelyInvesting` | boolean\|null |  | Whether the fund is currently deploying capital. | — |

### `rfp`

RFP-specific attributes. The issuing organisation is sponsoringOrganizations[0], the budget is the top-level funding envelope, and the proposal deadline is a deadlines entry labelled 'application'.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `scope` | string\|null |  | Scope of work, as one free-text field. In-scope and out-of-scope prose both live here. | — |
| `requirements` | string[], unique |  | Free-text statements of what the work must deliver. RFP-only, and deliberately not split into hard and soft. What a proposal must contain goes in the top-level prerequisites instead. | — |

<!-- END generated:fields -->

---

## Documentation conventions

The re-cut leaves several fields whose **boundaries are conventional rather than
schema-enforced**. Each is stated here because otherwise publishers guess and the data drifts.

| Convention | Ruling |
|---|---|
| **`sponsoringOrganizations` ≠ source of funds** | It is the **issuer/backer**, not necessarily where the money comes from. For donor-funded models the party running the process belongs in `operatingOrganizations`, while `sponsoringOrganizations` carries the display/issuing entity. **The money's actual origin is deliberately not modelled.** |
| **`applicationUrl` = whatever the submission channel is** | Including a **forum thread** when no portal exists. Clarifications go in `description`. **There is no submission-channel field** — the URL's *kind* is not typed. |
| **`prerequisites` vs. `rfp.requirements`** | **`prerequisites` = what a *proposal* must contain** (track record, approach, milestone plan, disclosures). **`rfp.requirements` = what the *work* must deliver.** Application-content vs. work-content. |
| **The three free-text siblings** | `prerequisites`, `resourceLinks` and `serviceAgreement` are all optional top-level strings and will be used interchangeably unless the boundary is written down — see below. |
| **`deadlines[]` selection** | Select by `label`, **never by array position**. |
| **`milestones[].amount` currency** | Optional, and it **MUST** follow the top-level `funding.currency` — a stated rule of the standard, not a soft convention. Schema-unenforceable (it crosses objects), so ingest **warns**. |
| **Milestone due dates** | There is no milestone date field. Where a publisher has due dates, they go in `criteria` as free text. |
| **Single-currency scope** | The single-currency rule governs the **program-level `funding` envelope only**; `bounty.reward`, `hackathon.prizes[].currency` and `accelerator.funding` each keep their own currency. |

### The three free-text siblings

`prerequisites`, `resourceLinks` and `serviceAgreement` are all optional top-level strings, and
each has one job:

- **`prerequisites`** — what an applicant must *put in the proposal* to be considered: track
  record, proposed approach, a milestone plan, conflict-of-interest disclosures. If the sentence
  starts "your application must include…", it belongs here.
- **`resourceLinks`** — supporting material a reader may want *alongside* the listing:
  guidelines, past rounds, forum threads, the original posting. Deliberately **one free-form
  string, not an array of URIs** — publishers paste what they have. If the sentence is a link
  with a label, it belongs here.
- **`serviceAgreement`** — how a **long-term service engagement** works, where the opportunity is
  one. Valid on any `fundingType`: an `rfp` or a `grant` carrying it reads as a service
  engagement rather than a one-off award. **Presence of the field is the signal**; duration,
  renewal and succession live in the prose if they matter. Deliberately **not filterable or
  facetable** — a consumer can test for presence but cannot query "engagements ≥ 12 months".

Requirements on *the work itself* are none of these three: they are `rfp.requirements` (RFP
only) or, for a scope statement, `rfp.scope`.

### `deadlines[]` — select by label, never by position

Every date in the standard lives in one array. Registration windows, submission windows,
application deadlines, community-feedback windows **and event boundaries** (`event start`,
`event end`) all fold into `deadlines[]`, distinguished by `label`. There is one date model in
the standard, not two.

The direct consequence: a consumer answering *"when must I apply by?"* **MUST filter on `label`.**
Taking `deadlines[0]` is wrong and will return a hackathon's start date. This is the accepted
cost of one unified date model.

- Conventional labels are published in
  [`registries/deadline-labels.json`](../../registries/deadline-labels.json) — `application`,
  `community feedback`, `registration`, `submission`, `event start`, `event end`. Labels stay
  free text; the registry keeps them comparable, and `rfphub-validate` warns on unregistered
  ones.
- `date` is **required and non-null** when `type` is `"fixed"` (schema-enforced via `if`/`then`);
  it is meaningless and normally omitted when `type` is `"rolling"`.
- There is deliberately **no event-anchored or relative form** — *"opens on X, then 30 days"* is
  unexpressible. A publisher posts a fixed date when the window actually opens. An opportunity in
  that state carries either no entry or a `rolling` one.
- There is deliberately **no `recurring` deadline type**. `grant.recurring` is the only carrier
  of a recurring-round concept.
- **API consumers:** an array is not a sortable scalar. The recommended derivation is
  `nextDeadlineAt` = the earliest future `type: "fixed"` date, computed at the API layer and
  never stored in the standard. Records carrying only `rolling` entries have no such value; they
  sort last and are **excluded** from deadline-window filters — an exclusion that must be
  documented by the consumer, not left silent. A staleness job that auto-closes on a passed
  deadline should key on *latest `fixed` deadline is in the past **and** no `rolling` entry
  exists*; rolling programs must never auto-close.

### `milestones[]` and currency

`milestones[]` is optional and valid on **any** `fundingType`. **Array order is the milestone
sequence** — there is no `order`/`index` field, exactly as `sponsoringOrganizations[0]` carries
"primary".

- `milestones[].amount` **MUST** be denominated in the top-level `funding.currency`. A milestone
  cannot be paid in a different asset from the envelope. JSON Schema cannot express this — the
  two live in different objects — so **ingest warns** when `milestones[].amount` is present and
  `funding.currency` is absent.
- There is **no milestone date field**. Due dates go into `criteria` as free text, consistent
  with every other free-text decision in the standard.
- Milestone-based payment *is* `milestones[]` plus `grant.milestoneBased`. There is no separate
  payment-schedule concept.

### Single currency — envelope only

The program-level `funding` envelope is **single-currency**: one `currency` scalar governs
`budget`, `allocated`, `minAward`, `maxAward` and `milestones[].amount`. There is no
`amounts[]`, no multi-asset envelope.

That rule is **scoped to the envelope**. `bounty.reward`, each `hackathon.prizes[].currency` and
`accelerator.funding` carry their own currency, because a prize pool can legitimately be
denominated differently from the program budget. The standard is single-currency *at the
envelope*, not end to end — this is a deliberate boundary, not an oversight.

Known cost, stated plainly: a program with **simultaneous caps in two assets** (e.g. a stablecoin
cap *and* a governance-token cap on the same round) cannot express both. Pick the primary
currency and put the second in `description`, or carry it under `extensions`. Both are lossy and
neither is filterable.

### `funding.allocated` is committed, not disbursed

`allocated` means money **committed to date** — not money paid out. Disbursement and delivery are
deliberately not modelled. `remaining` is **derived** as `budget − allocated` at the consumer
layer and never stored.

There is no `raised` field. A donor-crowdfunded opportunity therefore asserts its `budget`
regardless of how much has actually been raised, and a consumer cannot tell a fully-funded round
from one that has raised nothing. Publishers can note it in `description`; it is not filterable.

### Type blocks — one per opportunity

Every entry carries exactly one type-specific object under a key **equal to its `fundingType`
value**, so a consumer can always read `opportunity[opportunity.fundingType]` — a `hackathon`
entry has a `hackathon` object, a `vc_fund` entry has a `vc_fund` object.

The matching block is **required** for all six types (for grants it MAY be `{}`), and **no other
type block may be present**: a `grant` record carrying an `rfp` object **fails validation**. This
is enforced by the schema, not by convention, so `opportunity[opportunity.fundingType]` is a
guarantee rather than an expectation.

Service agreements are **not** a seventh type — they are the top-level `serviceAgreement` field,
orthogonal to `fundingType`.

### Self-identification

`$schema`, `@context` and `@type` are permitted at the top level despite
`additionalProperties: false`, so a document can name the contract it claims to conform to and be
consumed as linked data without a wrapper. They are **ignored by validation** — carrying a
`$schema` that points somewhere else does not change which schema a document is validated
against. See [`adr/0003`](../../../../adr/0003-instance-self-identification-and-version-pattern.md).

---

## Status semantics

`status` describes the **public lifecycle** of the opportunity, not editorial/review state:

| Value | Meaning |
|---|---|
| `upcoming` | Announced but not yet accepting applications. **Also the value for a pre-open posting** — see below. |
| `open` | Currently accepting applications. |
| `closed` | Deadline passed or no longer accepting. |
| `archived` | Withdrawn or retired. |

**There is no `draft` status.** A publisher wanting pre-open visibility uses `upcoming`; the
enum stays at four values. The reasoning is that a governing body does not publish a draft
opportunity to a public index — by the time an entry exists, it has been announced.

Review state (`pending`, `rejected`) and the verified/auto-approved distinction are **server-side
metadata**, not part of the public object.

Auto-closing is a consumer-side staleness concern, not a schema rule — see the deadline
derivation guidance above.

---

## Delivery (API list vs detail)

The schema defines the **canonical, full** opportunity object — used for the detail endpoint,
exports, snapshots, and agent payloads. For bandwidth, **list/search responses return a lighter
projection**: core fields only, omitting the type-specific block
(`opportunity[opportunity.fundingType]`) and `extensions`. Clients fetch the full object from the
detail endpoint (`GET /v1/opportunities/:id`). This is an API-delivery concern — it does not
change the object's canonical schema.

---

## Conformance

A document **conforms** to this version of the standard when it validates against
[`opportunity.schema.json`](./opportunity.schema.json).

An **implementation** conforms with respect to the published suite when every document in
[`conformance/v1.0.0/pass/`](../../conformance/v1.0.0/pass) validates and every document in
[`conformance/v1.0.0/fail/`](../../conformance/v1.0.0/fail) does not. The suite asserts nothing
about which error is reported, how many, or in what order. Passing it is **evidence of
conformance, not a definition of it** — the schema is the definition. Warnings from the advisory
tier (unregistered registry values, milestone amounts with no envelope currency) do **not** affect
conformance; a conforming document may raise warnings, which is the point of the split.

---

## Open items

- **Canonical domain** — undecided. Identifiers are provisional but honest: `$id` dereferences
  to the file in the repository, and `@vocab` is visibly marked `draft`. Both are stamped from
  `spec.config.json`, so adopting a domain is a one-line change. See
  [`STATUS.md`](./STATUS.md#known-issues-in-this-version).
- **Status granularity** — the four-value enum is the most-questioned part of the standard
  (`in review`, `paused`, `awarded` have all been asked for). It remains open on its own terms;
  the no-`draft` ruling above does not close it.
- **Level-of-effort / scope-complexity signal** — asked for, not modelled.
- **Cross-system dedup** — when the same opportunity is aggregated from more than one upstream
  source, a merge-precedence policy is needed at the read/aggregation layer. The removal of a
  source URL makes this a judgement call rather than a lookup.
