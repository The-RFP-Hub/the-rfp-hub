# Agent skills

This directory holds the RFP Hub's [Agent Skills](https://agentskills.io) — portable
`SKILL.md` bundles that any compatible coding agent can load to work with the RFP Hub directly,
without needing the API's shape explained to it first.

| Skill | What it does |
|---|---|
| [`funding-search`](funding-search/SKILL.md) | Search open Ethereum-ecosystem funding opportunities (grants, hackathons, bounties, accelerators, VC funds, RFPs) through the public API |

Each skill is a self-contained directory: `SKILL.md`, an optional `scripts/` with any executable
helpers, and an optional `references/` with detail the agent loads only when needed. The same
directory is installed as-is by every channel below — there is no per-agent build step, and
**nothing that is not part of the installed artifact lives inside it**. The skill's own tests are
therefore at [`test/skills/funding-search/`](../test/skills/funding-search) in the
repository root, not in the bundle: they import `vitest`, which an installed skill has no reason
to carry.

## Installing a skill

### 1. Multi-agent installer (recommended)

[`skills` by Vercel Labs](https://github.com/vercel-labs/skills) detects your installed coding
agents and copies the skill into each of their skill directories:

```sh
npx skills add The-RFP-Hub/the-rfp-hub --skill funding-search
```

### 2. Claude Code plugin marketplace

```sh
claude plugin marketplace add The-RFP-Hub/the-rfp-hub
claude plugin install rfp-hub@rfp-hub
```

This reads [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) at the repo
root, which points at this skill's own
[`.claude-plugin/plugin.json`](funding-search/.claude-plugin/plugin.json). The **plugin**
is `rfp-hub`; the **skill** it carries keeps its own name, so this channel presents the skill as
`rfp-hub:funding-search`. The other two channels install by directory name and apply no
namespace at all.

### 3. Manual copy

The same directory, copied to whichever agent's skill folder applies:

```sh
# Claude Code — project-local or global
cp -R skills/funding-search .claude/skills/
cp -R skills/funding-search ~/.claude/skills/

# Codex CLI — project-local or global
cp -R skills/funding-search .agents/skills/
cp -R skills/funding-search ~/.codex/skills/

# Cursor — project-local or global (cursor.com/docs/skills confirms both; also honors .claude/skills
# and .codex/skills for compatibility, so the Claude Code and Codex copies above work too)
cp -R skills/funding-search .cursor/skills/
cp -R skills/funding-search ~/.cursor/skills/

# GitHub Copilot (CLI, coding agent, and IDE integrations) — repository-level or, for the CLI,
# global (docs.github.com confirms these; .agents/skills above is ALSO a valid Copilot location)
cp -R skills/funding-search .github/skills/
cp -R skills/funding-search ~/.copilot/skills/

# Gemini CLI
cp -R skills/funding-search ~/.gemini/skills/
```

Cursor and GitHub Copilot paths confirmed against their official docs:
[cursor.com/docs/skills](https://cursor.com/docs/skills) and
[docs.github.com/en/copilot/concepts/agents/about-agent-skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
(repository-level path) /
[docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)
(adds the global `~/.copilot/skills` path, CLI-specific).

**Other Agent-Skills-compatible tools**: copy the directory to the location their own docs
specify — the bundle itself (`SKILL.md` + `scripts/` + `references/`) needs no per-agent changes.

## Why there's no npm channel

`packages/mcp`'s published tarball does not bundle `skills/` — npm has never been a skill
distribution channel, and the three channels above already reach every agent this project targets.
Keeping the skill out of the npm package also avoids a second, driftable copy of `SKILL.md`: this
directory is the only one that exists.

## Validating a skill

```sh
node scripts/check-skill.mjs        # frontmatter, name/dir match, line count, required sections
node skills/funding-search/scripts/search.mjs --q grant --limit 3   # live smoke test
npx vitest run test/skills          # the skill's own suites, including the clean-room install
pnpm test                            # everything, the above included
```

See [`scripts/check-skill.mjs`](../scripts/check-skill.mjs) at the repo root for what the CI
`Skill checks` step runs on every push.
