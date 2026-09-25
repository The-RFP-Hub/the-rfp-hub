# 0013. Move the project and the spec's identity to `rfpsear.ch`, as spec v1.0.1

- **Status:** accepted
- **Deciders:** project maintainers
- **Date:** 2026-09-25
- **Supersedes:** the domain choice of [ADR-0007](./0007-canonical-domain-and-spec-identity.md); its structure (apex reserved for the spec, single-label service hosts) stands

## Context and problem statement

The project is moving from `ethrfps.app` to `rfpsear.ch`: the site, the API and the name people
type. ADR-0007 minted every identifier the standard publishes on `ethrfps.app`, and v1.0.0 was
declared stable and FROZEN in the same change, so its `$id`s, its context's `@vocab` and its
self-identification examples are immutable bytes. The one-time provisional → canonical exemption in
the freeze gate is spent.

Leaving the standard's identity on the old domain while everything else moves would keep a second
domain in every document the Hub serves, forever, and would make the old domain the one people see
in every `$schema` they copy. The maintainers want the standard to live where the project lives.

## Decision drivers

- v1.0.0's published bytes cannot change: a consumer may have hashed them, and PROCESS.md promises
  they never will.
- Existing publishers send `"specVersion": "1.0.0"` today — from the reference form, the MCP server
  and hand-written integrations — and must not start failing on the day of the move.
- The data contract is not changing. Nothing about what a funding opportunity is has moved.
- The versionless artifacts (`meta/`, `registries/entry.schema.json`, the vocabulary document) name
  the current authority in their `$id` and are shared by every version.

## Considered options

1. **Keep the identity on `ethrfps.app`**; move only the site and the API.
2. **A new version, v1.0.1**, identical in contract, minted on `rfpsear.ch`, accepting documents
   that declare either `1.0.0` or `1.0.1`.
3. **A new major, v2.0.0**, minted on `rfpsear.ch`.

### Option 1

- Good, because nothing in the standard moves and the freeze stays untouched.
- Bad, because the old domain stays in every served document indefinitely, and must be kept
  registered and routed for identifiers the project no longer presents as its own.

### Option 2

- Good, because the version number says what happened: nothing in the contract changed.
- Good, because accepting `1.0.0` in `specVersion` keeps every existing publisher valid with no
  coordination.
- Bad, because PROCESS.md defines a patch as editorial and "never changes what validates", and a
  new accepted `specVersion` value does change what validates. The deviation is exactly one value
  of one field, and it is the version marker itself — any new version has to differ there.
- Bad, because the versionless `$id`s move, which the freeze gate rejected until this ADR.

### Option 3

- Good, because it is unambiguously allowed to change anything.
- Bad, because it tells every consumer to look for a contract change that does not exist.

## Decision outcome

**Chosen: Option 2.** Spec v1.0.1 is v1.0.0's contract published under `https://rfpsear.ch`, with
`specVersion` accepting `1.0.0` and `1.0.1`.

| Identifier | v1.0.0 (unchanged, forever) | v1.0.1 |
|---|---|---|
| Schema `$id` | `https://ethrfps.app/schemas/v1.0.0/opportunity.schema.json` | `https://rfpsear.ch/schemas/v1.0.1/opportunity.schema.json` |
| Context | `https://ethrfps.app/schemas/v1.0.0/context.jsonld` | `https://rfpsear.ch/schemas/v1.0.1/context.jsonld` |
| `@vocab` | `https://ethrfps.app/ns/rfp#` | `https://rfpsear.ch/ns/rfp#` |
| Meta-schema `$id` | — | `https://rfpsear.ch/meta/rfphub-schema.meta.json` |
| Registry entry-schema `$id` | — | `https://rfpsear.ch/registries/entry.schema.json` |

`spec.config.json` records the move in `identityMigrations`, naming this record, the previous
`baseUrl` (`https://ethrfps.app`) and `vocabIri` (`https://ethrfps.app/ns/rfp#`), and the versions
published under them (`1.0.0`).

The freeze gate gains a second, narrow exemption — the **identity migration** — held to the same
standard as the adoption: it applies only when `spec.config.json`'s newest `identityMigrations`
entry is new in the change, names an accepted ADR that names both identities, and its `from` is
exactly the identity at the base ref. Under it, the versionless artifacts may change their `$id`
and nothing else, byte for byte. Frozen version directories stay immutable; v1.0.0 is not touched.

## Consequences

- **Good:** one domain everywhere the project presents itself, and the version number is honest
  about the contract.
- **Good:** no publisher breaks: `1.0.0` documents validate against v1.0.1, and the API stores and
  serves them as `1.0.1`.
- **Bad:** `ethrfps.app` must stay registered and routed indefinitely. Its apex serves the v1.0.0
  tree (`/schemas/`, `/meta/`, `/registries/`, `/ns/`) and redirects everything else to
  `rfpsear.ch`; `api.ethrfps.app` keeps serving the API, because published MCP releases default to
  it and bind its origin into write approvals.
- **Bad:** v1.0.0 term IRIs (`https://ethrfps.app/ns/rfp#…`) and v1.0.1 term IRIs are different
  strings. The vocabulary document records that they name the same terms; a JSON-LD consumer
  merging data across the two versions has to apply that equivalence itself.
- **Bad:** `.ch` is not an HSTS-preloaded TLD, unlike `.app`. HTTPS is enforced by headers at the
  edge until the domain is submitted for preload.
- **Neutral:** the ADR-0007 rules carry over unchanged: the apex is reserved for the spec and its
  site, service hosts are single labels (`api.`, `api-staging.`, `staging.`).

## Follow-ups

- Operator steps (DNS, certificate, load balancer, Vercel domains, OAuth redirect URIs, email
  domain) are outside the repository and precede the merge; the deploy smoke tests call the new
  API hosts.
- Submit `rfpsear.ch` to the HSTS preload list once the redirects are stable.
