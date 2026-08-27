/**
 * Tool registration, and the one wrapper every handler goes through.
 *
 * NOTHING HERE KNOWS ABOUT A TRANSPORT. `createServer()` returns a configured `McpServer`;
 * `cli.ts` decides that it is served over stdio. Adding an HTTP entry later is a new file that
 * calls this one, not a refactor of it.
 *
 * The wrapper is where four cross-cutting rules live, so no tool can forget one:
 *   - the policy budget for the invocation's kind is spent before the work starts;
 *   - the result — text, structured content, and every error message — passes through redaction;
 *   - one audit line is written per call, recording key names and byte counts, never values;
 *   - a failure becomes an `isError` result carrying a code from the single error map, and an
 *     unexpected exception becomes `exec_failed` rather than a stack trace on the wire.
 *
 * FAIL-CLOSED REGISTRATION. The write tool is registered only when `RFPHUB_MCP_ENABLE_SUBMIT=1`.
 * Without it `tools/list` returns two tools, and a poisoned search result has no write tool to
 * reach for — which is a stronger property than a write tool that exists and refuses.
 */
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { appendAudit, summarizeInput } from "./audit.js";
import type { McpConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { ApiClient, type ApiClientOptions } from "./http.js";
import { Policy, type ToolKind } from "./policy.js";
import { redact, redactString, registerSecret } from "./redact.js";
import type { ToolContext, ToolSuccess } from "./tools/context.js";
import * as fetchTool from "./tools/fetch.js";
import * as searchTool from "./tools/search.js";
import * as submitTool from "./tools/submit.js";

export const SERVER_NAME = "rfp-hub";
export const SERVER_VERSION = "0.1.0";

/**
 * The MCP revision this server is built against, and one of the five components an approval binds
 * to.
 *
 * NOT the SDK's `LATEST_PROTOCOL_VERSION`, despite the name: in v2 that constant is `2025-11-25`,
 * the newest revision of the LEGACY era, and it appears in `SUPPORTED_PROTOCOL_VERSIONS` alongside
 * the older ones. The 2026-07-28 rewrite is a separate era — stateless, no `initialize`, no
 * session id — which the SDK handles through its era machinery and does not publish as an exported
 * constant. `enums.test.ts` asserts the value below is absent from `SUPPORTED_PROTOCOL_VERSIONS`,
 * so if a future SDK folds the two together this constant gets revisited rather than silently
 * becoming wrong.
 *
 * What binding it into an approval buys: an approval granted by one build of this server cannot be
 * spent by a build speaking a different revision. It does not vary per connection — `serveStdio`
 * serves a 2025-era client from the same registrations, and the approval records what this server
 * IS, not what a given client negotiated.
 */
export const PROTOCOL_VERSION = "2026-07-28";

export interface CreateServerOptions {
  config: McpConfig;
  /** Injected by the tests; production builds one from the config. */
  api?: ApiClient;
  apiClientOptions?: ApiClientOptions;
  policy?: Policy;
  now?: () => Date;
}

export function createServer(options: CreateServerOptions): McpServer {
  const { config } = options;
  // Registered so the redactor scrubs this exact string even if it does not match the key shape.
  registerSecret(config.apiKey);

  const ctx: ToolContext = {
    config,
    api: options.api ?? new ApiClient(config, options.apiClientOptions),
    policy: options.policy ?? new Policy(config.home),
    now: options.now ?? (() => new Date()),
    protocolVersion: PROTOCOL_VERSION,
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    searchTool.TOOL_NAME,
    {
      title: "Search funding opportunities",
      description: searchTool.TOOL_DESCRIPTION,
      inputSchema: searchTool.inputSchema,
      outputSchema: searchTool.outputSchema,
      // Hints, not enforcement — only some clients act on them. Set anyway: a client that does
      // use them should not have to guess that a search is a read.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => guard(searchTool.TOOL_NAME, "read", args, ctx, () => searchTool.run(args, ctx)),
  );

  server.registerTool(
    fetchTool.TOOL_NAME,
    {
      title: "Fetch one funding opportunity",
      description: fetchTool.TOOL_DESCRIPTION,
      inputSchema: fetchTool.inputSchema,
      outputSchema: fetchTool.outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => guard(fetchTool.TOOL_NAME, "read", args, ctx, () => fetchTool.run(args, ctx)),
  );

  if (config.submitEnabled) {
    server.registerTool(
      submitTool.TOOL_NAME,
      {
        title: "Submit a funding opportunity",
        description: submitTool.TOOL_DESCRIPTION,
        inputSchema: submitTool.inputSchema,
        outputSchema: submitTool.outputSchema,
        annotations: {
          readOnlyHint: false,
          // Not destructive: a submission adds an entry for review. It never removes or replaces
          // anything a caller did not name by id.
          destructiveHint: false,
          // Not idempotent from the client's side. The API recognises a byte-identical repeat from
          // the same submitter, but the caller cannot know a timed-out request did not land.
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      // The KIND is decided inside `run`, per phase: the preview spends the preview budget and the
      // commit spends the commit budget, and only when it reaches the POST. Passing `preview` here
      // would make five previews exhaust the daily write budget.
      (args) =>
        guard(submitTool.TOOL_NAME, "preview", args, ctx, () => submitTool.run(args, ctx), false),
    );
  }

  return server;
}

/**
 * Spend the budget (unless the tool does it itself), run, redact, audit, and turn any failure into
 * a coded error result.
 */
async function guard(
  tool: string,
  kind: ToolKind,
  args: unknown,
  ctx: ToolContext,
  work: () => Promise<ToolSuccess> | ToolSuccess,
  consumeBudget = true,
): Promise<CallToolResult> {
  const started = Date.now();
  const inputSummary = summarizeInput(args);
  let status = "ok";
  try {
    if (consumeBudget) ctx.policy.consume(kind);
    const result = await work();
    return {
      content: [{ type: "text", text: redactString(result.text) }],
      structuredContent: redact(result.structured),
    };
  } catch (err) {
    const error = toToolError(err);
    status = error.code;
    return {
      content: [{ type: "text", text: redactString(`[${error.code}] ${error.message}`) }],
      isError: true,
    };
  } finally {
    appendAudit(ctx.config.home, {
      at: new Date(started).toISOString(),
      tool,
      kind,
      status,
      inputSummary,
      durationMs: Date.now() - started,
    });
  }
}

/**
 * Every failure leaves as a code from the map. An exception this package did not raise becomes
 * `exec_failed` with its message redacted — never a stack trace, which can carry file paths and,
 * in an `fs` error, a directory name derived from an environment value.
 */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ToolError("exec_failed", `The tool failed unexpectedly: ${message}`);
}
