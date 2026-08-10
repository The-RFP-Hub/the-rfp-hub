---
"@the-rfp-hub/standard": major
"rfphub-validate": minor
---

Split the bounty type into task and security kinds, and give the security kind a payout table.

`BountyDetails` gains a required `bountyKind` (`task | security`), and `reward` becomes
optional on the type: it is required when `bountyKind` is `task`, while a security bounty
carries `rewardTiers[]` instead. A TypeScript consumer reading `details.reward` without
narrowing on `bountyKind` no longer compiles, which is why this is a major.

New exported types `RewardTier` and `Payout`. A payout is tagged by `model` —
`fixed | range | up_to | percentage_of_value_at_risk | discretionary` — and carries the amounts
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
