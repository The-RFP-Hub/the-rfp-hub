/**
 * Tool registration, and the one boundary every failure goes through. Nothing here knows about a
 * transport, so an HTTP entry point is a new file rather than a refactor.
 *
 * `guard` spends the invocation's budget, redacts the result and every error message, writes one
 * audit line, and turns any failure into a coded `isError` result. `installErrorBoundary` extends
 * that to the SDK's own argument-validation and unknown-tool paths, which quote arguments back.
 *
 * The write tool is registered ONLY when a credential is configured: without `RFPHUB_API_KEY` a
 * poisoned search result has no write tool to reach for, which is stronger than one that exists
 * and refuses.
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
 * NOT the SDK's `LATEST_PROTOCOL_VERSION`: in v2 that is `2025-11-25`, the newest LEGACY-era
 * revision. The 2026-07-28 era is handled through the SDK's era machinery and is not exported as a
 * constant, so `enums.test.ts` asserts this value is absent from `SUPPORTED_PROTOCOL_VERSIONS` —
 * a future SDK that folds the two together revisits this line rather than silently outdating it.
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

/** A real coupling to a `private` internal shape, handled by refusing to start when it moves. */
interface RegisteredToolLike {
  enabled?: boolean;
  executor?: (args: unknown, ctx: unknown) => unknown;
}

interface ToolDispatchSeams {
  validateToolInput(tool: unknown, args: unknown, toolName: string): Promise<unknown>;
  createToolError(message: string): CallToolResult;
  _registeredTools: Record<string, RegisteredToolLike>;
}

/**
 * The SDK rejects malformed arguments BEFORE the callback runs and quotes them back — uncoded and
 * unredacted, so a property whose NAME is a credential would be echoed verbatim. The instance
 * properties assigned here shadow the prototype methods the dispatcher calls.
 */
function installErrorBoundary(server: McpServer, ctx: ToolContext): void {
  const seams = server as unknown as ToolDispatchSeams;
  if (
    typeof seams.validateToolInput !== "function" ||
    typeof seams.createToolError !== "function" ||
    typeof seams._registeredTools !== "object" ||
    seams._registeredTools === null
  ) {
    throw new Error(
      "The MCP SDK no longer exposes the tool-dispatch seams this server wraps to code, audit and " +
        "redact argument-validation failures. Refusing to start rather than serve without that " +
        "boundary. Re-point `installErrorBoundary` in src/server.ts at the current dispatch path.",
    );
  }
  const validate = seams.validateToolInput.bind(seams);
  const createError = seams.createToolError.bind(seams);

  seams.validateToolInput = async (tool, args, toolName) => {
    const started = Date.now();
    try {
      return await validate(tool, args, toolName);
    } catch (err) {
      // The attempt budget is charged HERE for a call that never reaches the handler — otherwise
      // malformed arguments are the one unmetered loop into the write tool. Best-effort, because
      // `rate_limited` would send the caller to fix the wrong thing: the arguments are still wrong.
      const kind: ToolKind = toolName === submitTool.TOOL_NAME ? "attempt" : "read";
      if (kind === "attempt") {
        try {
          ctx.policy.consume("attempt");
        } catch {
          // The argument error below is the more useful thing to return.
        }
      }
      const detail = redactString(err instanceof Error ? err.message : String(err));
      appendAudit(ctx.config.home, {
        at: new Date(started).toISOString(),
        tool: toolName,
        kind,
        status: "invalid_input",
        inputSummary: summarizeInput(args),
        durationMs: Date.now() - started,
      });
      // Already formatted: this path is upstream of `guard`, and the SDK's funnel takes only
      // `error.message`, so a bare `ToolError` would arrive with its code stripped off.
      throw new Error(
        formatToolError(
          new ToolError(
            "invalid_input",
            `Those arguments do not match ${toolName}'s input schema, so nothing ran. Every parameter is declared in the schema \`tools/list\` publishes, and an undeclared one is an error rather than a filter that silently does nothing. ${detail}`,
          ),
        ),
      );
    }
  };

  // Covers the SDK's own wording as well as this package's.
  seams.createToolError = (message: string) => createError(redactString(message));

  // The dispatcher throws a bare protocol error for an unknown tool OUTSIDE its own try block, so
  // it never becomes a coded result or an audit line. Interposing on the lookup puts it back on
  // the normal path. Installed after registration: `registerTool` refuses a name already present.
  const registry = seams._registeredTools;
  seams._registeredTools = new Proxy(registry, {
    get(target, name, receiver) {
      // `Object.hasOwn`, NOT `Reflect.has`: the latter reports `constructor`, `toString` and every
      // other prototype member as a present tool.
      if (typeof name !== "string" || Object.hasOwn(target, name)) {
        return Reflect.get(target, name, receiver);
      }
      return {
        enabled: true,
        executor: () => {
          appendAudit(ctx.config.home, {
            at: new Date().toISOString(),
            tool: name,
            // Inventing a kind here would put a phase in the log that never happened.
            kind: "read",
            status: "tool_not_found",
            inputSummary: { keys: [], bytes: 0 },
            durationMs: 0,
          });
          throw new Error(
            formatToolError(
              new ToolError(
                "tool_not_found",
                "This server does not offer a tool by that name. Call `tools/list` for the ones it does. The write tool is registered only when the operator configures RFPHUB_API_KEY, so its absence is a configuration choice, not an error.",
              ),
            ),
          );
        },
      } satisfies RegisteredToolLike;
    },
  }) as Record<string, RegisteredToolLike>;
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
      // Hints, not enforcement — only some clients act on them.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      guard(searchTool.TOOL_NAME, "read", args, ctx, () => searchTool.run(args, ctx), {
        outputSchema: searchTool.outputSchema,
      }),
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
    (args) =>
      guard(fetchTool.TOOL_NAME, "read", args, ctx, () => fetchTool.run(args, ctx), {
        outputSchema: fetchTool.outputSchema,
      }),
  );

  if (config.apiKey !== null) {
    server.registerTool(
      submitTool.TOOL_NAME,
      {
        title: "Submit a funding opportunity",
        description: submitTool.TOOL_DESCRIPTION,
        inputSchema: submitTool.inputSchema,
        outputSchema: submitTool.outputSchema,
        annotations: {
          readOnlyHint: false,
          // A submission adds an entry for review; it removes nothing the caller did not name.
          destructiveHint: false,
          // The API recognizes a byte-identical repeat, but a caller cannot know a timeout landed.
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      (args) => {
        // The kind is decided by the PHASE inside `run`, so `guard` spends nothing here and learns
        // from the callback which phase actually happened.
        let kind: ToolKind = "preview";
        const phaseCtx: ToolContext = {
          ...ctx,
          spentCommitBudget: () => {
            kind = "commit";
          },
        };
        return guard(
          submitTool.TOOL_NAME,
          () => kind,
          args,
          phaseCtx,
          () => {
            // Before any work, on every invocation: the phase budgets meter only calls that got
            // somewhere, which would leave the refusal path an unmetered loop.
            phaseCtx.policy.consume("attempt");
            return submitTool.run(args, phaseCtx);
          },
          { consumeBudget: false, outputSchema: submitTool.outputSchema },
        );
      },
    );
  }

  // After the registrations: the dispatcher is installed lazily on the first `registerTool`.
  installErrorBoundary(server, ctx);

  return server;
}

/** `kind` is a thunk when the tool learns its phase only as it runs. */
async function guard(
  tool: string,
  kind: ToolKind | (() => ToolKind),
  args: unknown,
  ctx: ToolContext,
  work: () => Promise<ToolSuccess> | ToolSuccess,
  options: { consumeBudget?: boolean; outputSchema?: OutputValidator } = {},
): Promise<CallToolResult> {
  const consumeBudget = options.consumeBudget ?? true;
  const started = Date.now();
  const inputSummary = summarizeInput(args);
  let status = "ok";
  try {
    if (consumeBudget && typeof kind !== "function") ctx.policy.consume(kind);
    const result = await work();
    const structured = redact(result.structured);

    // Here, not downstream where the SDK checks it: by then the audit line already says `ok`.
    const parsed = options.outputSchema?.safeParse(structured);
    if (parsed !== undefined && !parsed.success) {
      throw new ToolError(
        "exec_failed",
        `${tool} produced a result that does not match the shape it publishes in \`tools/list\`, so it was not returned. This is a defect in this server or a response from the API that no longer matches its documented contract; the underlying call may well have succeeded.`,
        { issues: parsed.error.issues.map((i) => `${i.path.join("/") || "(root)"}: ${i.message}`) },
      );
    }

    return {
      content: [{ type: "text", text: redactString(result.text) }],
      structuredContent: structured,
    };
  } catch (err) {
    const error = toToolError(err);
    status = error.code;
    return {
      content: [{ type: "text", text: formatToolError(error) }],
      isError: true,
    };
  } finally {
    appendAudit(ctx.config.home, {
      at: new Date(started).toISOString(),
      tool,
      kind: typeof kind === "function" ? kind() : kind,
      status,
      inputSummary,
      durationMs: Date.now() - started,
    });
  }
}

/** Just enough of a schema to avoid depending on one validation library's type surface. */
interface OutputValidator {
  safeParse(
    value: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** The ONE wire format for a coded failure. Two paths produce these and must agree. */
export function formatToolError(error: ToolError): string {
  return redactString(`[${error.code}] ${error.message}`);
}

/** Never a stack trace: an `fs` error carries file paths derived from environment values. */
export function toToolError(err: unknown): ToolError {
  if (err instanceof ToolError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ToolError("exec_failed", `The tool failed unexpectedly: ${message}`);
}
