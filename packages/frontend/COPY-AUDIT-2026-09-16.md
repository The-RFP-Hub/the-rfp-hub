# RFP Hub copy audit — 2026-09-16

Scope: every visitor-facing string in the files listed below. Admin, dashboard, review and listings-editor screens excluded. The line "An open index. Not an application portal." is out of scope and untouched everywhere it appears.

## 1. Tells checklist

1. "Every X, Y and Z ... in one place" — false-comprehensiveness headline shape.
2. Em dashes used as asides or pauses — ban, replace with period, comma, or colon.
3. Semicolons splicing two sentences for false gravity.
4. Forced rule-of-three lists ("submit, keep, see"; "review, rank, decide").
5. Clipped negative tails ("...not here.", "no X to Y and no Z to hand over").
6. "Not X, but Y" / "A public index, not a portal" reversal headlines.
7. Vague abstract noun phrases where a concrete one exists ("a program asking for a specific thing").
8. Over-explaining what the product is NOT, beyond the one protected line.
9. Sentences that describe the product ("RFP Hub lists...") instead of telling the reader what to do next.
10. Comma splices used to avoid a plain period.

---

## 2. Landing (`components/Landing.tsx`)

### `Landing.tsx:108` — H1
> "Every open grant, hackathon, bounty and RFP on Ethereum, in one place."

Score: 3. Tells: #1 (every X in one place), tricolon-plus-tail. This is the exact shape the owner flagged.

a) plain: "We index every open grant, hackathon, bounty and RFP on Ethereum."
b) tight: "Every open Ethereum grant, hackathon, bounty and RFP."
c) warm: "Find what's open on Ethereum: grants, hackathons, bounties, RFPs."

**Recommended: (c)** — leads with a verb aimed at the reader, uses a colon instead of a trailing appositive, and drops the "in one place" cadence entirely.

### `Landing.tsx:111` — lede
> "Each listing links to the program that runs it. Applications happen there, not here."

Score: 2. Tells: #5 (clipped negative tail "not here.").

a) plain: "Every listing links out to the program's own site. You apply there."
b) tight: "Click through, apply on their site."
c) warm: "Every listing takes you to the program running it, and that's where you apply."

**Recommended: (a)** — keeps both facts (link-out, apply-there) without the fragment-as-punchline ending.

### `Landing.tsx:35` — `TILE_COPY.rfp`
> "A program asking for a specific thing"

Score: 2. Tell: #7 (vague abstraction, describes rather than shows).

a) plain: "Wants a specific deliverable"
b) tight: "One specific ask"
c) warm: "They know what they want"

**Recommended: (c)** — matches the register of the sibling tiles ("In person and online", "Security, paid by severity") and reads as a fact about the funder, not a definition.

### `Landing.tsx:157` — tally caption
> "fixed deadlines only; rolling programs stay open"

Score: 2. Tell: #3 (semicolon splice).

a) plain: "Only fixed deadlines. Rolling programs stay open."
b) tight: "Fixed deadlines only"
c) warm: "Only programs with a real deadline, rolling ones don't close."

**Recommended: (a)** — same length, same facts, no semicolon.

### Left alone (fine as-is)
- "I'm looking for funding →" / "I publish a program →" and their notes.
- "Browse X open opportunities", "See all X open opportunities →".
- "Search by topic, org or city…" placeholder.
- "Open data" data-links line.
- "Closing soon", "Browse by type", "Largest open awards" section headers.
- "ranked by the stated ceiling, nothing else" footnote — has real voice.

---

## 3. Directory index (`app/directory/page.tsx`)

### `page.tsx:319-321` — lede
> "Every open grant, hackathon, bounty and RFP we have indexed. Apply on the program's own site."

Score: 3. Tell: #1 again, plus a clipped instructional second sentence.

a) plain: "Grants, hackathons, bounties and RFPs that are open right now. Apply on the program's own site."
b) tight: "What's open right now. Apply on the program's site."
c) warm: "Everything we've indexed that's still open, all pointing back to the program's own site."

**Recommended: (a)** — drops the "every" opener, keeps the enumeration as a fact rather than a claim of totality.

### `page.tsx:354-359` — publisher invitation footnote
> "Submit your opportunities, keep them current, and see what they get read and applied for. Signing in creates an account the first time; publishing without review additionally requires membership of a verified organization, which a reviewer grants."

Score: 3. Tells: #4 (rule-of-three "submit, keep, see"), #3 (semicolon), "additionally requires" stiffness.

a) plain: "Submit your programs and keep them current here. Signing in creates your account the first time. To publish without review, you also need to be a verified member of your organization, which a reviewer grants."
b) tight: "Submit and update your listings. Publishing without review needs verified org membership."
c) warm: "You can submit your programs here, keep them current, and see how many people read and applied. Signing in makes your account. Skipping review takes one more step: a reviewer has to verify your organization first."

**Recommended: (a)** — same three facts, split into three plain sentences instead of one semicolon-joined tricolon.

### `page.tsx:392-395` — sign-in explainer
> "Signing in is a one-time code emailed to you by this service. There is no password to choose or lose and no key to hand over. This browser stores a session so you can manage your account. Permissions are checked when you submit or manage a listing."

Score: 2. Tell: #5-adjacent (paired negation "no X to Y and no Z to hand over"), passive "is emailed to you", "are checked".

a) plain: "Signing in is a one-time code we email you, no password to set up. This browser remembers your session so you can manage your account. We check permissions whenever you submit or manage a listing."
b) tight: "One-time email code, no password. Session stays in this browser."
c) warm: "You'll get a one-time code by email, nothing to remember or lose. This browser holds your session, and we check permissions each time you submit or manage a listing."

**Recommended: (a)** — names the actor ("we email you", "we check") instead of the actorless passive, drops the negation-pair rhythm.

### Left alone (fine as-is)
- "Do you run one of these programs?" heading.
- "The rules are public and so is the appeal against one:" — has real voice.
- "Restoring your session…", "Log in" button.

---

## 4. Directory list (`components/DirectoryList.tsx`)

Nothing here scores 2 or above. The result line, empty states, and pill labels are already plain and specific:

- "Nothing matches those filters." / "Nothing published yet." / "Page X is past the end of this result." — good, distinct causes named separately (a UX-writing strength, not a tell).
- "Show closed and upcoming too" / "Show only what is open" / "Show every status" — concrete link text, verb-led.
- "Funding type and status match exactly; the search box matches words in the title, summary and description." — the one semicolon in this file. Minor (score 1), flagging for consistency: split into two sentences when this file is next touched.

---

## 5. Opportunity card (`components/OpportunityCard.tsx`)

No strings score above 1. "rolling" and "no award stated" are plain and correct.

---

## 6. Opportunity detail (`components/PublicOpportunity.tsx`)

### `PublicOpportunity.tsx:1748-1754` — no application link, body
> "That is what the publisher filed, not something missing from this page. Applications for this program are arranged wherever {operator} says — start from the program's own site."

Score: 2. Tell: #2 (em dash).

a) plain: "That's what the publisher filed, nothing is missing from this page. Applications are arranged wherever {operator} says, so start from the program's own site."
b) tight: "The publisher filed it this way. Start from the program's own site."
c) warm: "The publisher just didn't list one, this page isn't missing anything. Start from {operator}'s own site to find out how to apply."

**Recommended: (b)** — the first sentence is reassurance the reader doesn't need twice on the page (the bold line above it already says "states no application link"); cut to the instruction.

### `PublicOpportunity.tsx:1622-1625` — provenance intro
> "The Hub republishes what a publisher or a submitter stated. The check below is a low-bar anti-spam signal — the linked page exists and its title is about the same program — and never a fact-check of the amounts or the dates."

Score: 2. Tell: #2 (double em-dash aside).

a) plain: "The Hub republishes what a publisher or submitter stated. The check below only confirms the linked page exists and its title matches the program. It never fact-checks the amounts or the dates."
b) tight: "We republish what was submitted. This only checks the link is real, not the numbers."
c) warm: "We just republish what a publisher or submitter told us. The check below is a light anti-spam pass — does the link work, does the title match — not a fact-check of amounts or dates." *(keeps the em dash, so it fails the no-em-dash rule; shown only to demonstrate why (a) is preferred)*

**Recommended: (a)** — same precision, the aside becomes its own sentence instead of being boxed in dashes.

### `PublicOpportunity.tsx:1796` — copy-failure message
> "Could not copy — use the address bar"

Score: 1 (short, but a live system message with an em dash — flagging per instructions that CTAs/short strings with an em dash still need a fix).

a) plain: "Couldn't copy. Use the address bar instead."
b) tight: "Copy failed, use the address bar"
c) warm: "Couldn't copy that for you, grab it from the address bar."

**Recommended: (a)** — standard error-message shape (what failed, what to do), no dash.

### Left alone (fine as-is)
- "Apply on {org}'s site" / "Apply on the program's site" — the CTA doc comment even explains why this phrasing was chosen over a vaguer one; it's the right model for the rest of the site.
- "This listing states no application link." — flat, honest, no hedge.
- "Applying takes you to the program's own site." footnote.
- "You were redirected here: the listing you followed was merged into this one."
- "Title, organization, award and deadline as one image, for a group chat or a slide." — concrete, not a forced trio (it's four real facts).
- "published by its organization" / "listed, not yet claimed" status text.

---

## 7. Publishers directory (`app/publishers/page.tsx`)

### `page.tsx:134-138` — lede
> "Every organization with an open listing on the index. A **verified** one publishes to its own namespace without a second review; a **listed** one was indexed from public sources and has not claimed its listings yet."

Score: 3. Tells: #1 ("every"), #3 (semicolon).

a) plain: "Every organization currently running an open listing. A verified organization publishes straight to its own namespace, no second review. A listed one was indexed from public sources and hasn't claimed its listings yet."
b) tight: "Organizations with an open listing. Verified ones publish directly; listed ones haven't claimed their listings." *(still has a semicolon — shown only for contrast)*
c) warm: "These are the organizations with something open right now. Verified ones publish straight to their own namespace, no second review needed. Listed ones we found from public sources, they just haven't claimed their listings yet."

**Recommended: (a)** — splits the semiclause into two plain sentences and keeps "verified"/"listed" as the load-bearing terms.

### `page.tsx:145` — empty state detail
> "Every listing here still publishes — verification only removes the review wait for an organization's own future submissions."

Score: 2. Tell: #2 (em dash).

a) plain: "Every listing here still publishes. Verification just skips the review wait for an organization's own future submissions."
b) tight: "Listings still publish. Verification only skips the review wait."
c) warm: "Nothing stops publishing here, verification just means your next submissions skip the review queue."

**Recommended: (a)**

### Left alone (fine as-is)
- "Run one of these? Open your listing in the directory and claim it, or read how verification works. A reviewer grants it." — has real voice, concrete next step.
- "This publisher has not written a description." — honest, not apologetic.
- "linked, not embedded" label.

---

## 8. How it works (`app/how-it-works/page.tsx`)

### `page.tsx:161` — H1
> "Who's funding what on Ethereum, and where to apply."

Score: 0-1. Already conversational and specific; included because every headline gets alternatives regardless of score.

a) plain: "See who's funding what on Ethereum, and where to apply."
b) tight: "Who's funding what on Ethereum"
c) warm: "Here's who's funding what on Ethereum, and how to apply."

**Recommended: keep the current text.** None of the three alternatives improve on it; the current line is already the plain, human option.

### `page.tsx:163-166` — lede
> "RFP Hub lists grants, hackathons, bounties and RFPs from any organization building on Ethereum. We don't rank programs, review applications or decide who gets funded. We point you to the ones that are open."

Score: 2. Tell: #4/#9 (negative tricolon "don't rank...review...or decide"; describes the product rather than telling the reader what happens).

a) plain: "RFP Hub lists grants, hackathons, bounties and RFPs from any organization building on Ethereum. We don't review applications or pick winners. We just point you to what's open."
b) tight: "We list what's open on Ethereum. We don't review or fund anything."
c) warm: "We list every grant, hackathon, bounty and RFP we can find on Ethereum. We don't decide who wins any of them, our job is pointing you to what's open."

**Recommended: (a)** — collapses the three-item negation into one plain sentence, keeps the "we point you to what's open" line, which is the actual value proposition.

### `page.tsx:171` — Act 1 heading
> "A public index, not a portal"

Score: 2. Tell: #6 (reversal heading), and it's redundant with the protected line already used elsewhere on the same page ("An open index. Not an application portal.").

a) plain: "A public index"
b) tight: "Public index"
c) warm: "Open to anyone, run by no one"

**Recommended: (a)** — the negation is already said, verbatim, at the bottom of this page; saying it twice in different words is the over-explaining tell (#8).

### Left alone (fine as-is)
- "Search, read, leave" act heading — plain, concrete, three real verbs describing the actual flow (not a forced trio).
- All three `<ol>` step lists (Search / Read the listing / Apply on the program's site; Log in / Submit a listing / Get verified) — imperative, specific, correctly short.
- "No account needed. Open the directory" / "Already listed? Open it in the directory and claim it." — good CTAs.
- "Read the rules." block and its five-item list — a real enumeration of five distinct documents, not a padded trio.

### Folded reference sections (lower priority)
Skimmed the `#rule-*` details blocks. They read as genuinely human — first-person reasoning, real stakes ("A queue anybody can fill without limit is a queue where the careful submission behind forty careless ones waits weeks..."), no em dashes or forced trios found. No entry here scores above 1; nothing flagged.

---

## 9. Chrome (`components/Chrome.tsx`)

### `Chrome.tsx:348` — brand tagline
> "an open index of funding opportunities"

Score: 1, included because a tagline always gets alternatives. Tell: #7 (abstract noun phrase, no specificity).

a) plain: "an open index of Ethereum funding"
b) tight: "open Ethereum funding index"
c) warm: "every open grant and bounty on Ethereum, indexed"

**Recommended: (a)** — adds the one missing fact (Ethereum) that every other page states, without lengthening the tagline.

### Left alone (fine as-is)
- "Built with ♥ by Karma. Funded by the [Ethereum Foundation]." footer credit.
- "Open data · CC0 exports · MIT code" footer note.
- "Signed in as {identity}", "Log in" button.

---

## 10. States (`components/states.tsx`)

No string here scores above 1; this file is the strongest writing in the audit. Highlights that should be treated as the house style going forward:

- "Too many requests, too quickly." — short, plain, no hedge.
- "We couldn't find {what}." / "It may have moved, been merged, or no longer be available." — three real causes, not a padded trio.
- "Your sign-in has ended." / "Sign in again to continue to {what}. Nothing was lost, and you can pick up where you were." — reassuring without being saccharine.

---

## 11. Share card (`lib/share-card.ts`)

No new visitor-facing copy beyond `POSITIONING` (the protected line, untouched) and `"Award not stated"`, `"Rolling"`, both plain and already covered by pattern in section 6. Nothing flagged.

---

## 12. Metadata (`lib/root-metadata.ts`, layouts)

### `root-metadata.ts:12` — site title
> "RFP Hub — an open index of Ethereum funding"

Score: 2. Tell: #2 (em dash), and this string appears in every browser tab and search result on the site.

a) plain: "RFP Hub: an open index of Ethereum funding"
b) tight: "RFP Hub | Open Ethereum funding index"
c) warm: "RFP Hub, an open index of Ethereum funding"

**Recommended: (a)** — colon is the standard, clean separator for a `<title>` tag; no dash anywhere.

### `root-metadata.ts:16` — meta description
> "An open index of funding opportunities under one standard: read it without an account, and — for publishers — submit and maintain listings, read their traffic, and run the review queues."

Score: 3. Tells: #2 (double em-dash aside), #4 (rule-of-three "submit and maintain / read their traffic / run the review queues").

a) plain: "An open index of Ethereum funding opportunities under one standard. Read it without an account. Publishers can sign in to submit and maintain listings, check their traffic, and run their review queues."
b) tight: "Open index of Ethereum funding. No account needed to browse. Publishers sign in to manage listings."
c) warm: "An open index of Ethereum funding, built on one standard. Anyone can read it without an account, and publishers who sign in can submit listings, watch their traffic, and run their own review queue."

**Recommended: (a)** — this text shows up in search results and link previews, so it needs to read as three plain claims rather than one long aside-stuffed sentence.

### `directory/layout.tsx`, `opportunities/[id]/layout.tsx`
Only strings are the page title ("Directory") and the dynamic listing id, both under three words / non-prose. Nothing to flag.

---

## 13. Top 15 changes, ranked by impact

| Where | Current | Recommended | Why |
|---|---|---|---|
| Landing H1 (`Landing.tsx:108`) | "Every open grant, hackathon, bounty and RFP on Ethereum, in one place." | "Find what's open on Ethereum: grants, hackathons, bounties, RFPs." | This is the headline the owner explicitly rejected the shape of; the "every X, in one place" cadence is the single clearest tell on the site. |
| Landing lede (`Landing.tsx:111`) | "Each listing links to the program that runs it. Applications happen there, not here." | "Every listing links out to the program's own site. You apply there." | Drops the clipped "not here." punchline fragment. |
| Directory lede (`directory/page.tsx:319`) | "Every open grant, hackathon, bounty and RFP we have indexed. Apply on the program's own site." | "Grants, hackathons, bounties and RFPs that are open right now. Apply on the program's own site." | Same "every...in one place" family, seen by every anonymous visitor who lands on `/directory`. |
| How-it-works lede (`how-it-works/page.tsx:163`) | "...We don't rank programs, review applications or decide who gets funded. We point you to the ones that are open." | "...We don't review applications or pick winners. We just point you to what's open." | Collapses a three-item negation into one sentence; this page is the canonical explainer, linked from everywhere. |
| Meta description (`root-metadata.ts:16`) | "...read it without an account, and — for publishers — submit and maintain listings, read their traffic, and run the review queues." | "...Read it without an account. Publishers can sign in to submit and maintain listings, check their traffic, and run their review queues." | Appears in every search result and link preview; has both a double em-dash and a forced tricolon. |
| Site title (`root-metadata.ts:12`) | "RFP Hub — an open index of Ethereum funding" | "RFP Hub: an open index of Ethereum funding" | Sits in every browser tab; the em dash is a one-character fix. |
| Brand tagline (`Chrome.tsx:348`) | "an open index of funding opportunities" | "an open index of Ethereum funding" | Visible on every page in the header; currently the vaguest version of a fact stated precisely everywhere else. |
| Publishers lede (`publishers/page.tsx:134`) | "Every organization with an open listing on the index. A verified one publishes...; a listed one was indexed..." | "Every organization currently running an open listing. A verified organization publishes straight to its own namespace, no second review. A listed one was indexed from public sources and hasn't claimed its listings yet." | Semicolon-joined sentence on a page every prospective publisher reads first. |
| Publisher invitation footnote (`directory/page.tsx:354`) | "Submit your opportunities, keep them current, and see what they get read and applied for. Signing in creates an account...; publishing without review additionally requires..." | "Submit your programs and keep them current here. Signing in creates your account the first time. To publish without review, you also need to be a verified member of your organization, which a reviewer grants." | Forced rule-of-three plus a semicolon, on the card that converts a program manager into a publisher. |
| Sign-in explainer (`directory/page.tsx:392`) | "There is no password to choose or lose and no key to hand over." | "Signing in is a one-time code we email you, no password to set up." | Paired negation rhythm; also fixes an actorless passive ("is emailed to you" → "we email you"). |
| Provenance intro (`PublicOpportunity.tsx:1622`) | "...a low-bar anti-spam signal — the linked page exists and its title is about the same program — and never a fact-check..." | "...The check below only confirms the linked page exists and its title matches the program. It never fact-checks the amounts or the dates." | Double em-dash aside on every listing detail page. |
| No-application-link body (`PublicOpportunity.tsx:1751`) | "...Applications for this program are arranged wherever {operator} says — start from the program's own site." | "The publisher filed it this way. Start from the program's own site." | Em dash plus redundant reassurance right under a bold line that already says the same thing. |
| Empty-state detail (`publishers/page.tsx:145`) | "Every listing here still publishes — verification only removes the review wait..." | "Every listing here still publishes. Verification just skips the review wait for an organization's own future submissions." | Em dash on the very first thing a visitor sees if no publisher is verified yet. |
| Tally caption (`Landing.tsx:157`) | "fixed deadlines only; rolling programs stay open" | "Only fixed deadlines. Rolling programs stay open." | Small but visible on the homepage hero stats; semicolon fix. |
| RFP tile note (`Landing.tsx:35`) | "A program asking for a specific thing" | "They know what they want" | Replaces the one genuinely vague phrase among four otherwise concrete tile notes. |

---

## 14. Strings left alone (already fine)

- "Apply on {org}'s site" / "Apply on the program's site" (`PublicOpportunity.tsx`) — the model CTA for the rest of the site.
- "This listing states no application link." — flat and honest, no hedge.
- "Search, read, leave" / "Log in, submit, publish" act headings (`how-it-works/page.tsx`).
- The three `<ol>` step lists on `how-it-works` — genuinely short, imperative, specific.
- "Too many requests, too quickly." / "We couldn't find {what}." / "Your sign-in has ended." (`states.tsx`) — the strongest copy in the codebase; use as the reference voice.
- "Nothing matches those filters." / "Nothing published yet." / "Page X is past the end of this result." (`DirectoryList.tsx`) — correctly distinguishes three different empty causes instead of one generic message.
- "Run one of these? Open your listing in the directory and claim it, or read how verification works. A reviewer grants it." (`publishers/page.tsx`).
- "This publisher has not written a description." — plain, not apologetic.
- Footer credits and "Open data · CC0 exports · MIT code" (`Chrome.tsx`).
- The folded `#rule-*` reference sections on `how-it-works` — first-person, specific, no forced trios or em dashes found.
