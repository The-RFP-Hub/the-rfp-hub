# RFP Hub Standard v1.0.1 — Field Reference

> **Maturity: `stable`** — declared 2026-09-25, and this directory is frozen (`FROZEN`). This
> file is informative.

v1.0.1 is v1.0.0's contract under identifiers on `rfpsear.ch`
([`STATUS.md`](./STATUS.md)). The conventions, lifecycle semantics and conformance notes are
v1.0.0's: see [v1.0.0's `FIELDS.md`](../v1.0.0/FIELDS.md). Only the field tables are repeated
here, because they are generated from this version's schema.

- **Spec version:** `1.0.1`; an entry declaring `"1.0.0"` also conforms.
- **`$id`:** `https://rfpsear.ch/schemas/v1.0.1/opportunity.schema.json`

## Field reference

Generated from the schema by `pnpm codegen`; do not edit by hand.

<!-- BEGIN generated:fields -->

### Top-level fields

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `$schema` | string(uri) |  | Optional self-identification: the URL of the RFP Hub schema this document claims to conform to. Permitted so a generic validator can discover the contract from the instance alone. Ignored by validation — naming a different schema here does not change which schema the document is validated against. | — |
| `@context` | string \| object \| any[] |  | Optional JSON-LD context: a URL, an inline context object, or an array of either. Permitted so an instance can be consumed as linked data. Ignored by validation — the standard makes no claim about its contents. | — |
| `@type` | string \| any[] |  | Optional JSON-LD type, or an array of types. Permitted so an instance can be consumed as linked data; ignored by validation. | — |
| `specVersion` | `1.0.0` \| `1.0.1` | ✅ | The RFP Hub Standard version this entry conforms to. 1.0.1 changes only the standard's identifiers (its $id, context and vocabulary moved to rfpsear.ch); the data contract is 1.0.0's, so a document declaring 1.0.0 also conforms to this schema. New documents should declare 1.0.1. Consumers use it to select the correct validator. | — |
| `id` | string, ≤128, `^[A-Za-z0-9._:-]+$` | ✅ | Stable, unique identifier for the opportunity within the Hub. Immutable once assigned. A namespaced form is recommended but not required. | — |
| `fundingType` | `grant` \| `hackathon` \| `bounty` \| `accelerator` \| `vc_fund` \| `rfp` | ✅ | The kind of funding opportunity, and the structural discriminator of the standard. Every entry carries its type-specific details in `fundingDetails`, whose own `fundingType` tag names that object's shape and always equals this field — the binding allOf below keeps the two in step — so consumers can dispatch on either tag. For grants the details may carry nothing beyond the tag. | — |
| `title` | string, ≤300 | ✅ | Human-readable name of the opportunity. | — |
| `description` | string | ✅ | Full description of the opportunity. Markdown is permitted; consumers are advised to treat it as untrusted and sanitise before rendering. | — |
| `summary` | string\|null, ≤500 |  | Optional short teaser (roughly one or two sentences) for list and card views. | — |
| `status` | `upcoming` \| `open` \| `closed` \| `archived` | ✅ | Lifecycle status of the opportunity. 'upcoming' = announced but not yet accepting applications, and also the value for a pre-open posting — there is no 'draft' status; 'open' = currently accepting; 'closed' = no longer accepting; 'archived' = withdrawn or retired. Editorial and review state (pending, rejected) is not represented here — it is server-side metadata. | — |
| `sponsoringOrganizations` | [`organization`](#organization)[] |  | The organisations issuing or backing the opportunity — the issuer or backer, not necessarily the source of funds, because for donor-funded models the money's origin is deliberately not modelled. Optional, and may be absent or empty, when the operator is the only party to name or the backer is not published. The party running the process belongs in operatingOrganizations instead. | — |
| `operatingOrganizations` | [`organization`](#organization)[], min 1 | ✅ | The organisations that actually run the opportunity — intake, process and the application funnel, whether on their own behalf or a sponsor's. Array order is semantic: entry 0 is the primary organisation and the one to display. | — |
| `source` | [`provenance`](#provenance) | ✅ | Provenance of this entry. Required as an object, but every field inside it is optional, so `"source": {}` validates. Provenance completeness is a data-quality and ingestion-policy concern rather than a schema constraint. | — |
| `ecosystems` | string[], unique |  | Ethereum-family ecosystems this opportunity targets. The RFP Hub is ETH-scoped, but this is an open, extensible list — not a closed enum, and deliberately not registry-governed either — so L2s and ETH-adjacent ecosystems are first-class and a newly launched one needs no process. | — |
| `categories` | string[], unique |  | Topical categories. Free text. | — |
| `eligibility` | string\|null |  | Free text describing who may apply — stage, geography, jurisdiction, entity requirements, compliance constraints — in the publisher's own words. Deliberately unstructured: eligibility criteria vary too much across publishers to be comparable as data, so this field is for reading, not faceting. | — |
| `prerequisites` | string\|null |  | Free text describing what a proposal must contain to be considered — track record, approach, milestone plan, disclosures. Distinct from rfp.requirements, which describes what the work must deliver. | — |
| `additionalReferences` | string\|null |  | A single free-form string of supporting links and references — guidelines, past rounds, forum threads, original postings. Deliberately one string rather than an array of URIs, because publishers paste what they have. | — |
| `serviceAgreement` | string\|null |  | Free text describing how a service-agreement arrangement works. Valid on any fundingType — an rfp or grant carrying it reads as a long-term service engagement. Presence of the field is the signal; duration and renewal live in the text if they matter. Not filterable or facetable, by design. | — |
| `applicationUrl` | string(uri)\|null |  | URL where applicants submit or apply — the only URL that points at the opportunity itself, and therefore the only link-back target. It may carry whatever the submission channel is, including a forum thread when no portal exists; the URL's kind is not typed. Clarifications go in description. | — |
| `website` | string(uri)\|null |  | Primary website for the opportunity or program. | — |
| `logoUrl` | string(uri)\|null |  | URL of the program or organisation logo image. | — |
| `bannerUrl` | string(uri)\|null |  | URL of a banner or hero image. | — |
| `socialLinks` | [`socialLink`](#sociallink)[], unique |  | Social and community links for the opportunity or program, one entry per link. The same platform may appear in more than one entry when it has more than one URL; only whole-entry duplicates are rejected. | — |
| `fundingInfo` | [`funding`](#funding) |  | Program-level funding envelope: single currency, total budget, amount committed to date, and the per-award range. | — |
| `milestones` | [`milestone`](#milestone)[] |  | Optional milestone sequence, valid on any fundingType. Array order is the milestone sequence — there is no order or index field. Milestone-based payment is expressed by this array together with grant.milestoneBased; there is no separate payment-schedule concept. | — |
| `opensAt` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z') for when applications open. null means unknown. | — |
| `deadlines` | [`deadline`](#deadline)[], unique |  | All deadlines and event boundaries for the opportunity, each either a fixed date or rolling, distinguished by label. Consumers should select by label rather than by array position: the first entry may be a hackathon's start date rather than its application deadline. Conventional labels are published in registries/deadline-labels.json. (Selection-by-label is a consumer convention, not schema-enforceable; see FIELDS.md.) | — |
| `postedAt` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z') for when the opportunity was first publicly announced at the source. null means unknown. | — |
| `createdAt` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z') for when this entry was created in the Hub. null means unknown. | — |
| `updatedAt` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z') for when this entry was last modified in the Hub. null means unknown. | — |
| `fundingDetails` | [`grant`](#grant) \| [`hackathon`](#hackathon) \| [`bounty`](#bounty) \| [`accelerator`](#accelerator) \| [`vcFund`](#vcfund) \| [`rfp`](#rfp) | ✅ | The type-specific details for this opportunity: exactly one of the six detail shapes, self-described by its own required `fundingType` tag, which names the shape and equals the top-level `fundingType` (the binding allOf below keeps the two in step). | — |

### `organization`

An organisation sponsoring or operating the opportunity. Embedded on an opportunity as a descriptive summary; the same shape is the standalone Organization directory record.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `name` | string, ≤256 | ✅ | Display name of the organisation. | — |
| `slug` | string, `^[a-z0-9-]+$` | ✅ | Lowercase URL-safe identifier, and also the organisation's namespace. | — |
| `orgType` | `foundation` \| `dao` \| `company` \| `protocol` \| `program` \| `individual` \| `other` |  | Kind of entity. | — |
| `description` | string\|null |  | Short description of the organisation. | — |
| `website` | string(uri)\|null |  | The organisation's primary website. | — |
| `logoUrl` | string(uri)\|null |  | URL of the organisation's logo image. | — |
| `bannerUrl` | string(uri)\|null |  | URL of the organisation's banner or hero image. | — |
| `socialLinks` | [`socialLink`](#sociallink)[], unique |  | Social and community links for the organisation, one entry per link. The same platform may appear in more than one entry when it has more than one URL; only whole-entry duplicates are rejected. | — |
| `ecosystems` | string[], unique |  | Ethereum-family ecosystems the organisation operates in. Same open list as the top-level field. | — |
| `contacts` | [`contact`](#contact)[] |  | Named contact routes into the organisation. Optional, and every field of every entry is optional too. | — |

### `contact`

A named contact route into the organisation. Every property is optional and there is no minimum-one-identifier constraint, so `{}` validates — deliberately, because not every publisher can or will name a person.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `name` | string\|null |  | The person's name. | — |
| `role` | string\|null |  | Role in the program. | — |
| `telegram` | string\|null |  | Telegram handle. A handle rather than a URL — unlike a socialLinks entry with platform 'telegram', which is a link. | — |
| `email` | string(email)\|null |  | Email address. | — |

### `provenance`

How this entry reached the Hub and when it was last checked. Every field is optional, so `{}` validates. There is no source URL: link-back to the opportunity runs through the top-level applicationUrl alone.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `publisher` | string\|null |  | Namespace — an organisation slug — this entry was published under. Auto-approval requires the publishing account to be a member of this verified org. May differ from the sponsoring organisation. | — |
| `submittedBy` | string\|null |  | Who submitted or published this entry: a public handle, an organisation slug, or 'community' for anonymous community submissions. The internal account identity is never exposed. This is the attribution carrier for data-partner credit. | — |
| `submittedAt` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z') for when the entry was submitted or published to the Hub. Pairs with submittedBy. null means unknown. | — |
| `ingestedVia` | `publisher_api` \| `submission` \| `scrape` \| `import` \| `outbox`\|null |  | How this entry entered the Hub. 'outbox' is a one-way push from an upstream source system's outbox; 'import' is a backfill or seed import. Always set server-side by the ingestion layer. | — |
| `originalId` | string\|null |  | Identifier of this opportunity in the source system. | — |
| `verifiedAgainstSource` | boolean\|null |  | Whether the entry's fields were verified against the live opportunity by the verification-assist job. null means not yet checked. | — |
| `verifiedAt` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z') for the last verification. Record-level only — there is no per-field freshness. null means unknown. | — |
| `snapshotUrl` | string(uri)\|null |  | IPFS or archived snapshot of the opportunity taken at verification time. | — |

### `socialLink`

One social or community link: the platform it lives on and its full URL.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `platform` | `twitter` \| `discord` \| `github` \| `telegram` \| `farcaster` \| `forum` \| `blog` | ✅ | Which service the link points at. 'twitter' covers X/Twitter; 'forum' is the governance or community forum; 'blog' is the blog or announcements feed. | — |
| `url` | string(uri) | ✅ | Full URL of the profile, server, group or feed — a link, not a handle. | — |

### `funding`

The program-level funding envelope. Single-currency by design, and that rule is document-wide: fundingInfo.currency denominates every monetary amount in the document — budget, allocated, minAward and maxAward here, plus milestones[].amount, bounty.reward, hackathon.prizes[].amount, accelerator.funding and vcFund.checkSize. No sub-block carries a currency of its own. 'Remaining' is derived at the consumer layer as budget minus allocated, and never stored.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `currency` | string\|null, ≤16 |  | ISO 4217 code or token symbol denominating every monetary amount in the document: the amounts below, plus milestones[].amount, bounty.reward, hackathon.prizes[].amount, accelerator.funding and vcFund.checkSize. | — |
| `budget` | number\|null, ≥0 |  | Total program budget in major units. | — |
| `allocated` | number\|null, ≥0 |  | Amount committed to date in major units — committed, not necessarily disbursed. Disbursement and delivery are not modelled. | — |
| `minAward` | number\|null, ≥0 |  | Minimum individual award in major units. | — |
| `maxAward` | number\|null, ≥0 |  | Maximum individual award in major units. | — |

### `amountRange`

A lower and upper bound, denominated in the document-wide fundingInfo.currency. Either bound may be absent, expressing an open-ended range.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `min` | number\|null, ≥0 |  | Lower bound in major units of fundingInfo.currency. | — |
| `max` | number\|null, ≥0 |  | Upper bound in major units of fundingInfo.currency. | — |

### `deadline`

A single deadline or event boundary. A 'fixed' entry carries a date; 'rolling' means applications are accepted continuously.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `deadlineType` | `fixed` \| `rolling` | ✅ | Whether this deadline is a fixed point in time or an open-ended rolling window. | — |
| `date` | string(date-time)\|null, `Z$` |  | RFC 3339 timestamp in UTC (trailing 'Z'). Required and non-null when deadlineType is 'fixed', enforced by the if/then below; meaningless, and normally omitted, when deadlineType is 'rolling'. | — |
| `label` | string\|null, ≤120 |  | What this deadline is for. Free text; conventional values are published in registries/deadline-labels.json. This is how a consumer tells an application deadline from an event boundary. | [`deadline-labels`](../../registries/deadline-labels.json) |

### `milestone`

One milestone in an opportunity's milestone sequence. Every property is optional — a publisher may list titles with no amounts, or amounts with no criteria. There is no date field: where a publisher has a due date, it goes into `criteria` as free text.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `title` | string\|null |  | Short name of the milestone. | — |
| `amount` | number\|null, ≥0 |  | Payment for this milestone in major units of the document-wide fundingInfo.currency. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent. | — |
| `criteria` | string\|null |  | Free-text acceptance criteria, including any due date. | — |

### `grant`

The fundingDetails payload when fundingType is 'grant': grant-specific attributes not covered by the core fields. May carry nothing beyond its fundingType tag, because core funding and date fields live at the top level.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingType` | `grant` | ✅ | Names this block's shape; equals the top-level fundingType. | — |
| `fundingMechanisms` | (`retroactive` \| `proactive` \| `streaming` \| `quadratic` \| `matching` \| `other`)[], unique |  | How funds are allocated. An array because mechanisms co-occur: a funder can offer a fixed grant and a matching grant in the same program. | — |
| `programModel` | string\|null |  | The operating model of the program, as distinct from the funding instrument. An open list rather than a closed enum — conventional values are published in registries/program-models.json, and a publisher's own vocabulary is valid without a schema change. | [`program-models`](../../registries/program-models.json) |
| `milestoneBased` | boolean\|null |  | Whether disbursement is tied to milestones. Pairs with the top-level milestones array. | — |
| `recurring` | boolean\|null |  | Whether the program runs in recurring rounds or seasons. | — |

### `hackathon`

The fundingDetails payload when fundingType is 'hackathon': hackathon-specific attributes. All dates — registration, submission, event start and event end — live in the shared top-level deadlines array, distinguished by label.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingType` | `hackathon` | ✅ | Names this block's shape; equals the top-level fundingType. | — |
| `location` | string\|null |  | Physical location, or null for a fully online event. | — |
| `online` | boolean\|null |  | Whether the event is also, or only, held online. | — |
| `tracks` | string[], unique |  | Named tracks or themes participants can build against. | — |
| `prizes` | [`prize`](#prize)[] |  | The prize pool, one entry per prize, denominated in the document-wide fundingInfo.currency. | — |
| `teamSize` | [`teamSize`](#teamsize) |  | Permitted team size range. | — |

### `prize`

A single hackathon prize, optionally attributed to a track. Denominated in the document-wide fundingInfo.currency, like every monetary amount in the document.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `track` | string\|null |  | Track this prize belongs to, where prizes are tracked separately. | — |
| `amount` | number, ≥0 | ✅ | Prize amount in major units of fundingInfo.currency. | — |

### `teamSize`

Permitted team size, as an inclusive range. Either bound may be absent.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `min` | integer\|null, ≥1 |  | Minimum number of team members. | — |
| `max` | integer\|null, ≥1 |  | Maximum number of team members. | — |

### `bounty`

The fundingDetails payload when fundingType is 'bounty': bounty-specific attributes. Two kinds share this block, named by bountyKind. A 'task' bounty is a single scoped piece of work with one stated reward. A 'security' bounty is a standing vulnerability-disclosure program whose payout is a table of tiers, normally graded by severity and by the class of asset in scope. The two kinds carry different required fields, bound by the allOf below.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingType` | `bounty` | ✅ | Names this block's shape; equals the top-level fundingType. | — |
| `bountyKind` | `task` \| `security` | ✅ | Which kind of bounty this is, and the discriminator for what the payout looks like. 'task' = one scoped piece of work paying a single reward; 'security' = a standing vulnerability-disclosure program paying against a tier table. This is about payout shape, not about how long the bounty stays open: intake duration lives in the top-level deadlines array, and either kind may be rolling. **(provisional)** | — |
| `reward` | number, ≥0 |  | The reward paid on completion, in major units of the document-wide fundingInfo.currency. The compensation for a bounty that pays one amount. Exactly one of this and rewardTiers is present on any bounty, enforced by the if/then/else below: they are alternative descriptions of the same money, so a document carrying both leaves a consumer no way to tell which is authoritative. A security bounty is forbidden from carrying it at all and states its amounts in rewardTiers, because a graded program has no single reward and collapsing the table to one number overstates what a typical report pays. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent. | — |
| `rewardTiers` | [`rewardTier`](#rewardtier)[], min 1 |  | The payout table, one entry per tier. The payout table, one entry per tier. Required when bountyKind is 'security', and the alternative to reward on a task bounty that grades its payout — a placement ladder, for instance — rather than paying one flat amount. Exactly one of this and reward is present, enforced by the if/then/else below. Array order carries no meaning; select by the tier's own severity, assetType or label. **(provisional)** | — |
| `severityScheme` | string\|null |  | The published classification the tier severities are drawn from, named so a consumer can tell whose definition of 'critical' is in play. Free text, because these schemes are documents rather than a vocabulary worth governing. **(provisional)** | — |
| `rewardPoolStatus` | `funded` \| `unfunded` \| `unknown`\|null |  | Whether the money behind the advertised amounts is actually held. 'funded' = escrowed or otherwise verifiably reserved; 'unfunded' = advertised as an intent to pay, with nothing set aside; 'unknown' = not published, which is the honest value where the program says nothing and the reason absent does not read as 'unfunded'. Separate from fundingInfo.budget, which carries the amount: a program can name a large maximum and hold nothing against it. **(provisional)** | — |
| `difficulty` | `beginner` \| `intermediate` \| `advanced`\|null |  | Self-assessed difficulty, as a hint to applicants. Meaningful on a task bounty; a security program grades by severity in rewardTiers instead. | — |
| `skills` | string[], unique |  | Skills the task calls for. Free text. | — |
| `platform` | string\|null |  | Platform hosting the bounty. | — |

### `rewardTier`

One row of a bounty's payout table: what is being paid for, and what it pays. The 'what for' is a selector — severity and assetType form a compound coordinate where a program grades on both, and label carries a grading axis neither describes. Each is individually optional so a program grading on one axis carries only that one, but at least one is required by the minProperties rule below: a row with no selector is an anonymous rule nothing can be matched against, not a tier. The payout is the other required part, because a tier that names no amount and no payout model is not a tier either.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `severity` | string |  | Severity band this row pays for. An open list rather than a closed enum — conventional values are published in registries/bounty-severities.json, and a program's own vocabulary is valid without a schema change. Name the scheme these are drawn from in severityScheme. **(provisional)** | [`bounty-severities`](../../registries/bounty-severities.json) |
| `assetType` | string |  | Class of in-scope asset this row pays for, where a program grades the same severity differently by what was found. An open list rather than a closed enum — conventional values are published in registries/bounty-asset-types.json. Absent where a program grades on severity alone. **(provisional)** | [`bounty-asset-types`](../../registries/bounty-asset-types.json) |
| `label` | string, ≤120 |  | What this row pays for, in the publisher's own words, where severity and assetType do not describe it — a placement in a prize ladder, or a named category. This is a selector, not a caption: it is how a consumer picks the row out when the structured dimensions do not apply. Where it accompanies severity or assetType it reads as a caption, and a consumer that facets should prefer the structured dimensions. Free text. **(provisional)** | — |
| `payout` | [`payout`](#payout) | ✅ | What this tier pays, and on which model. | — |

### `payout`

What a tier pays, tagged by the model that determines which of the amounts below apply. Every amount is in major units of the document-wide fundingInfo.currency, the same rule that governs every other monetary value in the document. Amounts that do not apply to the stated model are meaningless and normally omitted, the same convention deadline.date follows.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `model` | `fixed` \| `range` \| `up_to` \| `percentage` \| `discretionary` | ✅ | How this tier's payout is determined. 'fixed' pays one amount; 'range' pays somewhere between two bounds; 'up_to' names a ceiling with no floor; 'percentage' pays a share of a quantity the basis field names, optionally bounded by floor and cap; 'discretionary' names no figure at all, because the payer decides case by case, and carries none of the amount fields. The last is a real published position, not missing data — programs run numeric tiers and discretionary tiers side by side in the same table. **(provisional)** | — |
| `amount` | number\|null, ≥0 |  | The amount paid, where the model is 'fixed'. Required and non-null for that model, enforced by the if/then/else below. **(provisional)** | — |
| `min` | number\|null, ≥0 |  | Lower bound, where the model is 'range'. Required and non-null for that model, enforced by the if/then/else below. **(provisional)** | — |
| `max` | number\|null, ≥0 |  | Upper bound, where the model is 'range' or 'up_to'. Required and non-null for both, enforced by the if/then/else below. **(provisional)** | — |
| `percent` | number\|null, ≥0, ≤100 |  | Share this tier pays, as a percentage between 0 and 100 — a program paying 'up to 10% of funds affected' carries 10 here. What the share is *of* is named by basis, not assumed. Required and non-null where the model is 'percentage', enforced by the if/then/else below. **(provisional)** | — |
| `basis` | `value_at_risk` \| `economic_damage` |  | What the percentage is a share of. Required where the model is 'percentage' and forbidden on every other model, enforced by the if/then/else below. 'value_at_risk' = the funds the finding could have taken, the construction most programs publish; 'economic_damage' = the loss actually caused, which some programs cap against instead. The two are not interchangeable and a program that states one is not stating the other, which is why the model tag no longer asserts a basis of its own. The list grows by spec release as programs attest a new one. **(provisional)** | — |
| `floor` | number\|null, ≥0 |  | Least the tier pays regardless of the computed figure, where a percentage model states a minimum. Optional; absent means the computation is unbounded below. **(provisional)** | — |
| `cap` | number\|null, ≥0 |  | Most the tier pays regardless of the computed figure, where a percentage model states a maximum. Optional; absent means the computation is unbounded above. **(provisional)** | — |

### `accelerator`

The fundingDetails payload when fundingType is 'accelerator': accelerator-specific attributes. The application deadline lives in the shared top-level deadlines array with label 'application'.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingType` | `accelerator` | ✅ | Names this block's shape; equals the top-level fundingType. | — |
| `programDurationWeeks` | integer\|null, ≥0 |  | Length of the program in weeks. | — |
| `batchSize` | integer\|null, ≥0 |  | Number of teams accepted per cohort. | — |
| `equity` | string\|null |  | Equity taken, expressed as a string because programs state it in incomparable ways. | — |
| `funding` | number\|null, ≥0 |  | Investment or stipend offered per team, in major units of the document-wide fundingInfo.currency. That denomination rule is a requirement on publishers but crosses two objects, so it is not schema-enforceable; see FIELDS.md. The validator's advisory tier warns when this is present and fundingInfo.currency is absent. | — |
| `stage` | `pre-seed` \| `seed` \| `series-a`\|null |  | Company stage the program targets. | — |
| `location` | string\|null |  | Physical location, or null for a fully remote program. | — |
| `online` | boolean\|null |  | Whether the program is also, or only, run remotely. | — |

### `vcFund`

The fundingDetails payload when fundingType is 'vc_fund': venture-fund-specific attributes. A fund is an ongoing source of capital rather than a round, so it carries no deadline of its own.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingType` | `vc_fund` | ✅ | Names this block's shape; equals the top-level fundingType. | — |
| `checkSize` | [`amountRange`](#amountrange) |  | Typical investment size, as a range denominated in the document-wide fundingInfo.currency. | — |
| `stages` | (`pre-seed` \| `seed` \| `series-a` \| `series-b+` \| `growth`)[], unique |  | Investment stages the fund participates in. | — |
| `thesis` | string\|null |  | Investment thesis, in the fund's own words. | — |
| `portfolio` | string[], unique |  | Named portfolio companies, where the fund publishes them. | — |
| `contactMethod` | `email` \| `form` \| `intro-only`\|null |  | How the fund prefers to be approached. 'intro-only' means a warm introduction is required. | — |
| `activelyInvesting` | boolean\|null |  | Whether the fund is currently deploying capital. | — |

### `rfp`

The fundingDetails payload when fundingType is 'rfp': RFP-specific attributes. The issuing organisation is operatingOrganizations[0], the budget is the top-level fundingInfo envelope, and the proposal deadline is a deadlines entry labelled 'application'.

| Field | Type | Req. | Description | Registry |
|---|---|:--:|---|---|
| `fundingType` | `rfp` | ✅ | Names this block's shape; equals the top-level fundingType. | — |
| `scope` | string\|null |  | Scope of work, as one free-text field. In-scope and out-of-scope prose both live here. | — |
| `requirements` | string[], unique |  | Free-text statements of what the work must deliver. RFP-only, and deliberately not split into hard and soft. What a proposal must contain goes in the top-level prerequisites instead. | — |

<!-- END generated:fields -->
