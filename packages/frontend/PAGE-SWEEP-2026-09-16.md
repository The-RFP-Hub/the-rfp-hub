# RFP Hub page sweep — 2026-09-16

Scope: every route under `src/app`, plus `src/components/Chrome.tsx`, `states.tsx`, `SignIn.tsx`, `PublisherJourney.tsx`, `ClaimForm.tsx`, `OpportunityForm.tsx`, `badges.tsx`, `SectionNav.tsx`, `ReturnLink.tsx`, and `src/lib/presentation.ts`. Baseline confirmed green: `biome check src test` reports 0 issues on 163 files.

Category 2 (copy tells) reuses the copy audit's own scope line — public pages only (landing, directory, opportunity detail, how-it-works, publishers, organizations, privacy, terms). Admin, dashboard, review and the listings editor were swept for categories 1, 3 and 4, but their prose is internal-operator copy and wasn't scored against the tells checklist, matching `COPY-AUDIT-2026-09-16.md`'s own exclusion.

## Summary

- **Old IA (category 1):** clean. No `href="/"` used as "the directory" (the two `href="/"` instances in `Chrome.tsx` are correctly the brand mark going home). No hand-rolled funding-type plurals outside `lib/presentation.ts` — every render path uses `fundingTypeLabel`/`fundingTypeChipLabel`/`fundingTypePlural`. `auth/complete/page.tsx:149` and `how-it-works/page.tsx:481` already say "Back to the directory" → `/directory`, which is correct post-redesign.
- **Copy tells (category 2):** the copy audit already covered Landing and most of `directory/page.tsx`. Two public strings it missed still score 2–3: an em-dash aside on `organizations/page.tsx` and a product-description opener on `publishers/page.tsx`.
- **Visual system (category 3):** two structural CSS gaps (`.landing`, `.landing-hero-copy`, `.directory-type`, `.directory-status` referenced in TSX with zero matching rules in `globals.css`), one unwrapped `<table>` on the dashboard analytics tab, six dead selectors in `globals.css`, and two long/multi-sentence `.lede` blocks beyond Landing's already-audited one. No stray `style={{` outside the two OG-image routes (which need it for Satori) and the three files the visual-system test already pins.
- **British spelling (category 4):** none in visitor-facing copy. Every "colour"/"behaviour"/"organisation" hit is in a code comment (`globals.css`, `manifest.ts`, `review/page.tsx`, `organizations/[slug]/page.tsx`, `BrandMark.tsx`, `badges.tsx`, `OpportunityForm.module.css`) or the intentional `/organisations` redirect route (`review/page.tsx:110`, out of scope by design).

---

## 1. Old information architecture

| File:line | Finding |
|---|---|
| — | None found. `Chrome.tsx:343,482` `href="/"` is the brand/footer mark going to the landing page, which is correct now that `/` is the landing and `/directory` is the table. `auth/complete/page.tsx:149` and `how-it-works/page.tsx:481` both say "Back to the directory" and link `/directory`, matching the new IA. No file hand-rolls a funding-type label or plural; `DirectoryList.tsx:596`'s `PILL_TYPES` array holds wire tokens only, and every display call goes through `lib/presentation.ts`. |

---

## 2. Copy tells (public pages only)

| File:line | String | Score | Tell | Replacement |
|---|---|---|---|---|
| `src/app/organizations/page.tsx:52-54` | "What each of these lets you do depends on whether it is verified — that is a reviewer's decision, and it is what decides whether your listings publish immediately or wait." | 3 | #2 em-dash aside, run-on with a trailing "and it is" clause | "What each of these lets you do depends on whether it is verified. A reviewer decides that, and it decides whether your listings publish immediately or wait." |
| `src/app/publishers/page.tsx:34` | "Every organization currently running an open listing." | 2 | #9 describes the product/page instead of orienting the reader | "Organizations with at least one open listing right now." |
| `src/app/organizations/page.tsx:39` | "Submissions from this account land pending, which is the normal path for a community submission. Claiming a listing for an organization you run is how that changes — a reviewer grants the membership." | 2 | #2 em-dash aside closing the sentence | "...Claiming a listing for an organization you run is how that changes. A reviewer grants the membership." |

Everything else already reviewed in `COPY-AUDIT-2026-09-16.md` (Landing, directory lede/footnote/sign-in explainer) stands; re-checked and unchanged since that report.

Out of scope but worth flagging separately if the exclusion is ever lifted: `admin/`, `review/`, `listings/`, `keys/`, `account/`, `duplicates/`, `how-it-works/page.tsx` (matrix and role prose) use the em dash as a structural label/explanation separator dozens of times (e.g. `review/page.tsx:1159,1481,1713`, `admin/page.tsx:267,313-314`, `OpportunityForm.tsx` hints throughout). That reads as this design system's convention for operator-facing hint text, not an aside — recommend leaving it alone rather than retrofitting the public-page rule onto internal screens.

---

## 3. Visual-system inconsistencies

| File:line | Finding |
|---|---|
| `src/components/Landing.tsx:47` `className="landing"` | No `.landing` rule in `globals.css` (only `.landing-hero`, `.landing-paths`, etc. exist). Either dead attribute or missing base rule — confirm intent. |
| `src/components/Landing.tsx:81` `className="landing-hero-copy"` | Same: no `.landing-hero-copy` selector anywhere in `globals.css`. |
| `src/components/DirectoryList.tsx:781` `className="directory-type"` | No `.directory-type` rule in `globals.css` (sibling cells `directory-organization`, `directory-award` are styled via `.directory-table .directory-organization` compounds; this one isn't). |
| `src/components/DirectoryList.tsx:816` `className="directory-status"` | Same gap — no `.directory-status` selector anywhere. |
| `src/components/AnalyticsTab.tsx:127` `<table>` | Not wrapped in `.table-scroll`, unlike every other table in the app (`account`, `admin`, `dashboard`, `duplicates`, `keys`, `how-it-works`, `listings`, `organizations`, `review`, `PublicOpportunity`, `OpportunityForm` all wrap). This table (dashboard "Day by day" breakdown) will overflow on narrow viewports without a scroll container. |
| Dead CSS in `globals.css` | Selectors with no matching class anywhere in `src/app` or `src/components` TSX: `.badge-approved`, `.badge-archived`, `.badge-closed`, `.badge-hidden`, `.badge-live`, `.badge-open`, `.badge-rejected`, `.badge-upcoming` (dashboard/opportunity status variants that `badges.tsx` never emits — it only ever builds `badge-${reviewStatus\|publisherStatus\|...}` from a different vocabulary: `pending/approved/rejected/merged/listed/unlisted/verified/unverified/matched/unmatched/unknown`). |
| `.card` usage | `publishers/page.tsx:80` uses `<p className="card">` for what functions as a closing footnote strip ("Run one of these?"), the same role `directory/page.tsx:66`'s publisher-invite `<section className="card">` plays. Consistent with each other, but both differ from Landing/directory's dedicated `.landing-block`/strip patterns elsewhere — not a bug, just worth a design-system decision on whether "closing footnote" gets its own class instead of borrowing `.card`. |
| `.lede` length | `src/app/privacy/page.tsx:14-19` — 4 sentences. `src/app/terms/page.tsx:14-17`, `src/app/admin/page.tsx:53-56`, `src/app/how-it-works/page.tsx:164-167`, `src/app/publishers/page.tsx:34-38` — each 3 sentences, over the audit's two-sentence lede convention. Privacy/terms carry an "Effective [date]" sentence that could move out of the lede into its own line. |
| `style={{` | No occurrences outside `src/app/card.png/route.tsx` and `src/app/opportunities/[id]/card.png/route.tsx` (both `ImageResponse`/Satori routes, which require inline styles — legitimate) and the three files `test/visual-system.test.ts:150-156` already pins clean (`keys/page.tsx`, `review/page.tsx`, `organizations/[slug]/page.tsx`). |

---

## 4. British spellings

None in visitor-facing copy. Every hit is either a code comment or the intentionally-named redirect route:

| File:line | Word | Note |
|---|---|---|
| `src/app/globals.css:13,21-22,48,156-157,277,499,560,800,808,986,1148,1782-1784,1843,2357` | "colour"/"colourless"/"coloured"/"centred" | All in `/* */` design-rationale comments, not rendered. |
| `src/app/manifest.ts:13` | "colour" | Comment. |
| `src/app/review/page.tsx:14,110` | "behaviour", "organisations" | Comment; and `organisations` string is the deliberate `/organisations` → `/organizations` redirect alias tab check, out of scope per task brief. |
| `src/app/organizations/[slug]/page.tsx:926` | "behaviour" | Comment. |
| `src/components/BrandMark.tsx:10` | "colour" | Comment. |
| `src/components/badges.tsx:11` | "colour" | Comment. |
| `src/components/OpportunityForm.module.css:203,411` | "colour" | Comments. |

No occurrences of "licence" (as a verb), "favour", "analyse", "programme", or "catalogue" anywhere in visible copy or comments.

---

## Fix first (ranked, ≤15 items)

1. `src/components/AnalyticsTab.tsx:127` — dashboard "Day by day" table has no `.table-scroll` wrapper, inconsistent with every other table and a real overflow risk on mobile. Wrap: `<div className="table-scroll"><table>...</table></div>`.
2. `src/components/DirectoryList.tsx:781` — `directory-type` cell class has no CSS rule; confirm whether it needs one (the type chip inside it is styled, but the `<td>` itself isn't via this hook) or drop the dead class.
3. `src/components/DirectoryList.tsx:816` — same gap for `directory-status`.
4. `src/components/Landing.tsx:47` — `className="landing"` has no matching `globals.css` rule; either add `.landing { }` or remove the dead attribute.
5. `src/components/Landing.tsx:81` — `className="landing-hero-copy"` same dead-class issue.
6. `src/app/organizations/page.tsx:52-54` — em-dash aside, tell #2, score 3. Replace with: "What each of these lets you do depends on whether it is verified. A reviewer decides that, and it decides whether your listings publish immediately or wait."
7. `src/app/publishers/page.tsx:34` — product-description opener, tell #9, score 2. Replace with: "Organizations with at least one open listing right now."
8. Dead CSS in `src/app/globals.css` — `.badge-approved`, `.badge-archived`, `.badge-closed`, `.badge-hidden`, `.badge-live`, `.badge-open`, `.badge-rejected`, `.badge-upcoming` are never emitted by `badges.tsx`; remove or reconcile with the actual badge vocabulary.
9. `src/app/organizations/page.tsx:39` — trailing em-dash aside, tell #2, score 2. Replace with two sentences: "...Claiming a listing for an organization you run is how that changes. A reviewer grants the membership."
10. `src/app/privacy/page.tsx:14-19` — 4-sentence lede; move "Effective 31 August 2026." out of the lede paragraph into its own line to match the two-sentence lede convention elsewhere.
11. `src/app/terms/page.tsx:14-17` — 3-sentence lede; same fix, move the effective-date sentence out.
12. `src/app/publishers/page.tsx:34-38` — 3-sentence lede; consider splitting the verified/listed definitions out of the lede into the two section intros below (`Verified`/`Listed` headings) rather than front-loading both in the top paragraph.
13. `src/app/admin/page.tsx:53-56` — 3-sentence lede (internal page, lower priority but flagged for consistency with the audit's lede convention).
14. `src/app/how-it-works/page.tsx:164-167` — 3-sentence lede; the middle sentence ("We don't review applications or pick winners.") could move into the "acts" section immediately below it, which already covers this ground.
