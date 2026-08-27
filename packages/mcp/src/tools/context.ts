/**
 * What every tool handler is given, and the two result helpers they all use.
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
}

/** A successful tool result: human-readable text plus the same data as `structuredContent`. */
export interface ToolSuccess {
  text: string;
  structured: Record<string, unknown>;
}
