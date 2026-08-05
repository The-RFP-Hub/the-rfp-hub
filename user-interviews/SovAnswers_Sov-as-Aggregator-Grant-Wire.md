# My Answers: Sov as Aggregator (Grant Wire)

_Part of: Sov's Answers for RFP_

Background: I have been building crypto grants discovery tools since 2021. I built LlamaoGrants with DefiLlama, the first Web3 grants discovery platform. In 2023, I led Grantfarm at Blockworks. I also worked on the onchain grants registry on Allo v2.
Crypto Grant Wire has been the scouting layer behind all of that work. It helps me find programs, keep track of changes, and see where money is moving.

## Core questions
1. How do you source opportunities today? Tools, cadence.
Each day I collect new leads, remove duplicates, filter out weak matches, review the remaining items by hand, and post the good ones the same day. On Fridays, I recheck the last seven days and turn them into the weekly digest.
Most leads come from three places:
- X searches that I run by hand with saved Grok prompts
- RSS and web search scans from my system (Wire Room Ops)
- Items I find while working and forward into the system
Everything lands in one database through a Telegram intake bot. Each item gets a URL, source, and first-seen timestamp. The system checks whether I have already seen it, usually by normalized URL and program name.
After that, a simple five-part filter removes most of the noise. Of the items that reach my review queue, about one in four is worth publishing. Approved items go to the right Grant Wire channel. The Friday digest pulls from the previous seven days and ships through Sovereign Signal.
2. Where does that process break down? What costs you the most time?
Search mostly finds the grants I already know how to look for. If a program is announced loudly on X, I usually catch it.
The harder misses are quieter. A funder might update its own site, open an application portal, mention a program in a newsletter, or change a deadline without making a public announcement. Those are real opportunities, but they often sit outside the places aggregators watch.
That is where a shared hub would help. The value is not scraping the same public posts everyone already sees. The value is giving funders a simple place to publish opportunities in a clean format, then letting aggregators pull from it.
For Grant Wire, the useful part would be comparison. I could compare my own list against the hub, then see what I missed, what I already had, and which records need fixing.
3. What information is most often missing or wrong?
Deadlines are the biggest problem. Announcements often skip them. If a deadline exists, it usually lives on the application page, so my process includes a step where I open that page and check.
Deadline type matters too. A fixed date, a rolling program, and a quarterly round are different things. Most listings flatten them into one field.
Status changes also rot quickly. Programs close early, pause, reopen, or extend without a clear announcement. That is why I re-open every link before publishing.
Amounts and eligibility are often missing at first. Sometimes they get added later. Sometimes they never do.
Duplicates are another recurring issue. One opportunity can show up as an X post, blog post, forum thread, docs page, and application link. A lot of the work is deciding whether those are separate items or the same program.
4. What would a neutral, open hub need to do for you to use it weekly?
It would need to become one more feed in my intake process. If the data is clean, connecting it would take about an hour.
I would keep using it if it had three things:
- Breadth: I can filter noise, but I cannot recover what I never see
- Stable IDs: each listing needs an ID that does not change
- Trustworthy timestamps: my weekly digest depends on a strict seven-day window
Bad timestamps quietly break the digest. If an item has the wrong posted or updated date, it can disappear from the week it should have been included in.
5. Which fields actually matter?
The useful fields are:
- Program name
- Funder
- Source URLs
- Deadline type: fixed, rolling, recurring round
- Amount or budget range
- Eligibility
- Status
- Posted timestamp
- Stable ID
Source URLs matter because they let me verify the listing. The X post, blog post, forum thread, and application page may all describe the same opportunity. If the hub stores those aliases, deduping becomes a lookup instead of a judgment call.
I do not need contact information for my readers. They need the application link.
6. Would you contribute data back?
Yes, if it works through an API. I would not use a web form for this. Forms are hard to script, batch, or track in version control.
Grant Wire already normalizes listings and tracks status changes. Pushing corrections back upstream would be a small script. Useful contributions would include deadline fixes, closed-early flags, and newly found mirror URLs.
Attribution matters. If a correction is marked as flagged by Grant Wire, the contribution also becomes distribution, a backlink, and a credibility signal.

## Aggregator tail
How do you source opportunities today, automated vs manual share?
The mechanics are covered above.  The system (Wire Room Ops) handles intake, deduping, filtering, scoring, queue assembly, and channel posting.
I still handle the work that requires judgment: daily X scans, prompt writing, approvals, rejections, and all writing.
By item count, automation touches almost everything. By hours spent, the work is still the review queue, the search prompts, and the Friday weekly.
Discovery is the least automated part. That is also the part outsiders usually assume is automated. I have tried automating it twice. Both attempts found nothing that the manual scans had missed.
What do you need from the API?
Assume I would call the API every morning with a cron job, plus one backfill when I first connect it.
Must have
- Stable IDs
- Canonical Source URLs
- Posted and updated timestamps
- Structured deadline and deadline type
- Status history with timestamps: announced, open, closing, closed, awarded
- Bulk export
- Delta endpoint for new or changed records
The hub does not need to be the biggest feed to be useful. It needs to be the most reliable source for the listings it carries.