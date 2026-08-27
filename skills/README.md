# Agent skills

This directory holds the RFP Hub's [Agent Skills](https://agentskills.io) — portable
`SKILL.md` bundles that any compatible coding agent can load to work with the RFP Hub directly,
without needing the API's shape explained to it first.

| Skill | What it does |
|---|---|
| [`rfp-hub-funding-search`](rfp-hub-funding-search/SKILL.md) | Search open Ethereum-ecosystem funding opportunities (grants, hackathons, bounties, accelerators, VC funds, RFPs) through the public API |

Each skill is a self-contained directory: `SKILL.md`, an optional `scripts/` with any executable
helpers, and an optional `references/` with detail the agent loads only when needed. The same
directory is installed as-is by every channel below — there is no per-agent build step.

## Installing a skill

### 1. Multi-agent installer (recommended)

[`skills` by Vercel Labs](https://github.com/vercel-labs/skills) detects your installed coding
agents and copies the skill into each of their skill directories:

```sh
npx skills add The-RFP-Hub/the-rfp-hub --skill rfp-hub-funding-search
```

### 2. Claude Code plugin marketplace

```sh
claude plugin marketplace add The-RFP-Hub/the-rfp-hub
claude plugin install rfp-hub-funding-search@rfp-hub
```

This reads [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) at the repo
root, which points at this skill's own
[`.claude-plugin/plugin.json`](rfp-hub-funding-search/.claude-plugin/plugin.json).

### 3. Manual copy

The same directory, copied to whichever agent's skill folder applies:

```sh
# Claude Code — project-local or global
cp -R skills/rfp-hub-funding-search .claude/skills/
cp -R skills/rfp-hub-funding-search ~/.claude/skills/

# Codex CLI — project-local or global
cp -R skills/rfp-hub-funding-search .agents/skills/
cp -R skills/rfp-hub-funding-search ~/.agents/skills/

# Gemini CLI
cp -R skills/rfp-hub-funding-search ~/.gemini/skills/
```

**Cursor / GitHub Copilot**: both have announced or shipped Agent Skills support compatible with
this same `SKILL.md` format; consult their current docs for the install path *(verify)* — this
repository does not pin a location for them because neither has published one this project has
independently confirmed.

## Why there's no npm channel

`packages/mcp`'s published tarball does not bundle `skills/` — npm has never been a skill
distribution channel, and the three channels above already reach every agent this project targets.
Keeping the skill out of the npm package also avoids a second, driftable copy of `SKILL.md`: this
directory is the only one that exists.

## Validating a skill

```sh
node scripts/check-skill.mjs        # frontmatter, name/dir match, line count, required sections
node skills/rfp-hub-funding-search/scripts/search.mjs --q grant --limit 3   # live smoke test
pnpm test                            # unit tests, including the projection's content-safety test
```

See [`scripts/check-skill.mjs`](../scripts/check-skill.mjs) at the repo root for what the CI
`Skill checks` step runs on every push.
