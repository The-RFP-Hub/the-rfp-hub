---
"@the-rfp-hub/standard": minor
"rfphub-validate": minor
---

Split the bounty type into task and security kinds, and give the security kind a payout table.

`BountyDetails` gains a required `bountyKind` (`task | security`), and compensation becomes
exactly one of the scalar `reward` or the `rewardTiers[]` table: a task bounty carries
whichever describes it (a graded placement ladder is a table), and a security bounty must use
the table.

**Released as a minor, deliberately, though it is technically breaking.** A TypeScript consumer
reading `details.reward` without narrowing on `bountyKind` no longer compiles. The maintainers
released it as a minor on the judgement that the package has no real dependants yet — the
download counts are automated traffic — and that a second major inside one release cycle would
signal more churn than the change represents. If you are that consumer, narrow on `bountyKind`
first.

New exported types `RewardTier` and `Payout`. A payout is tagged by `model` —
`fixed | range | up_to | percentage | discretionary` — and carries the amounts
that model requires. `discretionary` is a published position, not absent data.

Two new registries govern the tier vocabularies (`bounty-severities`, `bounty-asset-types`);
both fields stay open strings.

The whole surface is `x-stability: provisional`: it rests on a measured corpus of 247 real
programs, of which 3 were representable under the previous single-`reward` shape, but no
consumer has shipped against it yet.

`rfphub-validate`'s `amount-without-currency` advisory now traverses every reward-tier payout
bound.

Migrating an existing bounty document: add `"bountyKind": "task"`. The previous shape was a
task bounty in everything but name, and no other value changes.
