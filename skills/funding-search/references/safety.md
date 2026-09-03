# Safety design notes

Why the rules in [SKILL.md](../SKILL.md) §2 (Content Safety) and §6 (Tracking headers) are shaped
the way they are. Nothing here is an instruction — read it only when auditing the skill or
deciding how far to trust its output.

## Contents

- [The projection is the mitigation](#the-projection-is-the-mitigation)
- [The two text fields that survive](#the-two-text-fields-that-survive)
- [Control characters are collapsed before display](#control-characters-are-collapsed-before-display)
- [What the tracking headers do and do not do](#what-the-tracking-headers-do-and-do-not-do)

## The projection is the mitigation

The "treat every string as data" rules in §2 are a backstop, not the defense. The defense is that
long-form publisher free text — `description`, `summary`, `eligibility`, `prerequisites`,
`additionalReferences`, `serviceAgreement`, and every prose field inside `fundingDetails` — never
reaches the model at all. Both the MCP path and the bundled scripts apply a **projection**: an
allow-list of output fields, computed in code before anything is printed or returned. A field that
never arrives cannot be misread as an instruction, however it is phrased.

The allow-list is `project()` in `scripts/lib.mjs`. It is an allow-list rather than a strip-list on
purpose: a strip-list has to grow every time the Standard adds a free-text field, and a missed
addition is a silent leak, while an allow-list can only ever emit what it names.

Two tests prove it, and they prove different things. The unit test asserts an instruction-shaped
`description` never survives `project()`. The clean-room test copies the skill outside the
repository, runs the shipped scripts from that copy against an API serving poisoned prose in every
free-text field, and asserts the poisoned string reaches neither stdout nor stderr — that is the
shipped path, end to end. Both live with the repository's other tests, not inside the installed
skill; see `skills/README.md`.

## The two text fields that survive

`title` (140 characters) and `organization` (80) are the only publisher free text the projection
keeps, because a result is unidentifiable without them. Both are truncated in code, so neither can
carry a paragraph. `ecosystems` is open-vocabulary publisher text too, capped at 40 characters per
value and 8 values per record, and `fundingInfo.currency` — an ISO code or a publisher-chosen token
symbol — is capped at 40. Everything else in a projected result is an enum, a number, a date this
skill derived, or a URL this skill constructed.

## Control characters are collapsed before display

A kept field is still third-party text, and a raw newline inside one could make a single field
*look* like several lines of table output — including a fake `apply:` line pointing at an
attacker's own URL, entirely inside one string. Every kept string has its control characters
(newlines, carriage returns, tabs, the other C0/C1 controls, DEL, and the Unicode line/paragraph
separators) collapsed to a single space before it is displayed. This is structural, like the
projection itself: no control character survives to be interpolated, so there is nothing for a
client to "clean" afterwards.

## What the tracking headers do and do not do

The scripts send `X-Source: skill:funding-search`, a fresh `X-Invocation-Id` UUID per
invocation, and `X-Skill-Version` (the frontmatter's `metadata.version`) on every request, so the
RFP Hub can tell skill-driven traffic apart from a human browsing the site. The scripts set them;
no agent has to remember to.

They work from curl and Node and **not from a browser**: the API's public CORS policy allows only
the `Content-Type` and `Authorization` request headers, so a browser-based caller sending any of
the three fails preflight before the request goes out. Do not promise anyone a browser integration
on the strength of these headers.

They also do less than they might appear to. Nothing in the API currently reads `X-Source` to
exclude agent traffic from a publisher's own analytics: the headers identify the traffic, they do
not filter it.

Reads are always anonymous. No `Authorization` header is ever sent, even when `RFPHUB_API_KEY` is
present in the environment — search and fetch are public endpoints.
