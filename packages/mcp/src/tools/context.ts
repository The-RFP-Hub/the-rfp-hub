/**
 * What every tool handler is given, and the result shape they all return.
 *
 * Handlers throw `ToolError` and never build an error result themselves: exactly one place turns a
 * failure into a response, which is what makes "no tool invents a code outside the map" testable.
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
   * Called as the request goes out. The audit line must name the KIND that happened, and this tool
   * is a preview on one invocation and a commit on the next.
   */
  spentCommitBudget?: () => void;
}

/** Human-readable text plus the same data as `structuredContent`. */
export interface ToolSuccess {
  text: string;
  structured: Record<string, unknown>;
}
