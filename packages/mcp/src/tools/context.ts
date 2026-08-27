/**
 * What every tool handler is given, and the result shape they all return.
 *
 * Handlers throw `ToolError` and never build an error result themselves — `server.ts` catches,
 * redacts, audits and formats. That is the only way the "no tool invents a code outside the map"
 * test can hold: there is exactly one place that turns a failure into a response.
 */
import type { McpConfig } from "../config.js";
import type { ApiClient } from "../http.js";
import type { Policy } from "../policy.js";

export interface ToolContext {
  config: McpConfig;
  api: ApiClient;
  policy: Policy;
  now: () => Date;
  /** The MCP revision this server implements; one of the five things an approval binds to. */
  protocolVersion: string;
  /**
   * Called by the write tool at the moment it stops being a preview and becomes a write — after
   * the budget is committed and the approval claimed, as the request goes out.
   *
   * The audit line has to say which KIND of thing actually happened, and for this tool that is not
   * knowable when the call starts: the same tool name is a preview on one invocation and a commit
   * on the next. Recording `preview` for a call that submitted would make the audit log wrong
   * about the only entries anyone will ever go looking for.
   */
  spentCommitBudget?: () => void;
}

/** A successful tool result: human-readable text plus the same data as `structuredContent`. */
export interface ToolSuccess {
  text: string;
  structured: Record<string, unknown>;
}
