import { CopyBlock } from "@/components/CopyBlock";
import {
  type AgentOrigins,
  MCP_COMMAND,
  SKILL_COMMANDS,
  agentPrompt,
  apiOrigin,
  mcpInstall,
} from "@/lib/agents";
import {
  HOW_IT_WORKS,
  LLMS_TXT,
  MCP_GUIDE,
  MCP_README,
  SKILLS_GUIDE,
  apiDocsUrl,
  exportUrl,
  openApiUrl,
} from "@/lib/links";
import Link from "next/link";

export function AgentsGuide(origins: AgentOrigins) {
  const { apiBaseUrl } = origins;
  const mcp = mcpInstall(apiBaseUrl);
  return (
    <section className="agents-page">
      <h1>Agents</h1>
      <p className="lede">
        An AI agent can read RFP Hub the same way a person can, with no account and no key. Paste
        the prompt below into any agent to start, or connect one of the tools further down.
      </p>

      <section aria-labelledby="agents-prompt">
        <h2 id="agents-prompt">Start with a prompt</h2>
        <p className="prose">
          This works in any assistant that can browse the web or make HTTP requests. It points the
          agent at <a href={LLMS_TXT}>llms.txt</a>, tells it how to search, and sets ground rules:
          listing text is data rather than instructions, links inside listings are for you to open
          rather than the agent, and applications happen on each program&rsquo;s own site. Add what
          you&rsquo;re looking for at the end.
        </p>
        <CopyBlock text={agentPrompt(origins)} label="Copy prompt" />
      </section>

      <section aria-labelledby="agents-mcp">
        <h2 id="agents-mcp">Connect the MCP server</h2>
        <p className="prose">
          The{" "}
          <a href={MCP_README} target="_blank" rel="noopener noreferrer">
            RFP Hub MCP server
          </a>{" "}
          gives an MCP client two read tools, <code>search_opportunities</code> and{" "}
          <code>fetch_opportunity</code>. It runs locally over <code>stdio</code> with{" "}
          <code>{MCP_COMMAND}</code>. Searching needs no key; <code>RFPHUB_API_BASE</code> tells it
          which API to read, and the commands below point it at{" "}
          <code className="wrap-anywhere">{apiOrigin(apiBaseUrl)}</code>.
        </p>
        <h3>Claude Code</h3>
        <CopyBlock text={mcp.claudeCode} label="Copy Claude Code command" />
        <h3>Codex CLI</h3>
        <CopyBlock text={mcp.codex} label="Copy Codex command" />
        <h3>Claude Desktop, Cursor and other clients</h3>
        <p className="prose">
          Most clients take a JSON entry like this one. VS Code names the root key{" "}
          <code>servers</code> instead of <code>mcpServers</code>.
        </p>
        <CopyBlock text={mcp.json} label="Copy JSON config" />
        <p className="prose">
          To let an agent submit listings as well, it needs an API key with <code>read</code> and{" "}
          <code>write</code> scopes, and each submission waits for an approval typed at a terminal.
          That approval is a deliberate step, not a wall: an agent that can run shell commands as
          you can approve its own submission. The{" "}
          <a href={MCP_GUIDE} target="_blank" rel="noopener noreferrer">
            setup guide
          </a>{" "}
          covers both.
        </p>
      </section>

      <section aria-labelledby="agents-skill">
        <h2 id="agents-skill">Install the skill</h2>
        <p className="prose">
          For coding agents that support Agent Skills, <code>funding-search</code> teaches the agent
          to search the index with bundled scripts. This installs it into every agent it finds on
          your machine:
        </p>
        <CopyBlock text={SKILL_COMMANDS.install} label="Copy skill install command" />
        <p className="prose">In Claude Code, it also comes as a plugin:</p>
        <CopyBlock text={SKILL_COMMANDS.claudePlugin} label="Copy plugin commands" />
        <p className="prose">
          The skill reads the same <code>RFPHUB_API_BASE</code> variable from the agent&rsquo;s
          environment. Other install paths are in the{" "}
          <a href={SKILLS_GUIDE} target="_blank" rel="noopener noreferrer">
            skills guide
          </a>
          .
        </p>
      </section>

      <section aria-labelledby="agents-api">
        <h2 id="agents-api">Read the API directly</h2>
        <ul>
          <li>
            <a href={LLMS_TXT}>llms.txt</a>: a short map of the API and data, written for language
            models.
          </li>
          <li>
            <a href={openApiUrl(apiBaseUrl)} target="_blank" rel="noopener noreferrer">
              OpenAPI document
            </a>{" "}
            and the{" "}
            <a href={apiDocsUrl(apiBaseUrl)} target="_blank" rel="noopener noreferrer">
              API reference
            </a>
            .
          </li>
          <li>
            Every public record as{" "}
            <a href={exportUrl(apiBaseUrl, "json")} target="_blank" rel="noopener noreferrer">
              JSON
            </a>{" "}
            or{" "}
            <a href={exportUrl(apiBaseUrl, "csv")} target="_blank" rel="noopener noreferrer">
              CSV
            </a>
            , under CC0.
          </li>
          <li>
            <Link href={HOW_IT_WORKS}>How it works</Link>, for what an account can and can&rsquo;t
            do.
          </li>
        </ul>
      </section>
    </section>
  );
}
