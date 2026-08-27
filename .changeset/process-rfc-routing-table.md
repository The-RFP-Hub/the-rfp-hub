---
"@the-rfp-hub/standard": patch
---

Add an `RFC process` section to `PROCESS.md`, which ships inside the package tarball. It is a
routing table rather than a new process: proposing a field goes to the feature stages, registering
a vocabulary value to the registry criteria, a defect to the four errata labels, disagreeing with a
decision to the appeals path, and a structural decision to an ADR. The review windows are repeated
for convenience and name `GOVERNANCE.md` as the source of truth for them.

Also corrects a stale count in the registry section: there are four registries, not two —
`bounty-severities` and `bounty-asset-types` arrived with the security-bounty payout surface and
were never added to the prose.
