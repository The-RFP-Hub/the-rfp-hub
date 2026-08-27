/**
 * Tool registration, and the one boundary every failure goes through.
 *
 * NOTHING HERE KNOWS ABOUT A TRANSPORT. `createServer()` returns a configured server;
 * `cli.ts` decides that it is served over stdio. Adding an HTTP entry later is a new file that
 * calls this one, not a refactor of it.
 *
 * Four cross-cutting rules live in `guard`, so no tool can forget one:
 *   - the policy budget for the invocation's kind is spent before the work starts;
 *   - the result — text, structured content, and every error message — passes through redaction;
 *   - one audit line is written per call, recording key names and byte counts, never values;
 *   - a failure becomes an `isError` result carrying a code from the single error map, and an
 *     unexpected exception becomes `exec_failed` rather than a stack trace on the wire.
 *
 * ARGUMENT VALIDATION GOES THROUGH THE SAME BOUNDARY. The SDK validates a tool's arguments against
 * its declared schema BEFORE the callback runs, and its own failure quotes the offending arguments
 * back — outside `guard`, so uncoded, unaudited and unredacted. `installErrorBoundary` wraps that
 * step so a malformed call is refused the way every other refusal is. Redaction additionally sits
 * on the transport (`transport.ts`), because the SDK has error paths this package does not author
 * at all, such as an unknown tool name echoed in a JSON-RPC error.
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

/**
 * The two seams inside the SDK's `tools/call` dispatch that this package needs to reach.
 *
 * Both are ordinary prototype methods at run time, but the published types mark them `private`, so
 * a subclass cannot override them and this interface has to describe them separately. That is a
 * real coupling to an internal shape, and it is handled the only honest way: `installErrorBoundary`
 * REFUSES TO START if either seam is missing, rather than continuing with a security boundary that
 * silently is not there. An SDK upgrade that moves them fails immediately and loudly, in CI, on the
 * first server this package constructs.
 */
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
 * Route the SDK's argument validation and its error funnel through this package's boundary.
 *
 * WHY. The SDK validates a tool's arguments against its declared schema BEFORE the registered
 * callback runs, and its own rejection quotes the offending arguments back. That happens outside
 * `guard`: uncoded, unaudited, and unredacted — so an unknown property whose NAME is a credential
 * would be echoed to the caller verbatim. Wrapping the seam keeps the schema published in
 * `tools/list` exactly as authored (registering a permissive schema instead would hide the contract
 * from every client) while making a malformed call fail like every other failure here.
 *
 * The instance properties SHADOW the prototype methods, which is what makes this work: the
 * dispatcher calls them through `this`.
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
      const detail = redactString(err instanceof Error ? err.message : String(err));
      appendAudit(ctx.config.home, {
        at: new Date(started).toISOString(),
        tool: toolName,
        kind: "read",
        status: "invalid_input",
        inputSummary: summarizeInput(args),
        durationMs: Date.now() - started,
      });
      // Thrown ALREADY FORMATTED. This path does not run through `guard` — it is upstream of the
      // callback — and the SDK's funnel takes only `error.message`, so a bare `ToolError` would
      // arrive on the wire with its code stripped off. `formatToolError` is the one place the wire
      // shape is defined, so both paths produce the same thing.
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

  // The funnel every throw inside the dispatcher passes through on its way to an `isError` result.
  // Redacting here covers the SDK's own wording as well as this package's.
  seams.createToolError = (message: string) => createError(redactString(message));

  // UNKNOWN TOOLS. The dispatcher looks a tool up in this record and throws a bare protocol error
  // when it misses — outside its own try block, so that failure never becomes a coded result and
  // never reaches an audit line. Interposing on the LOOKUP puts it back inside the normal path: an
  // unknown name resolves to a tool whose only behaviour is to raise `tool_not_found`, which then
  // travels through the same funnel as everything else.
  //
  // This is why the proxy is installed AFTER registration: `registerTool` refuses a name that is
  // already present, and a proxy answering every name would make every registration a duplicate.
  //
  // A tool that exists but is switched off — `submit_opportunity` without the env flag is not
  // registered at all, but the SDK supports disabling — is left to the SDK, because the record
  // holds a real entry for it and this trap never fires.
  const registry = seams._registeredTools;
  seams._registeredTools = new Proxy(registry, {
    get(target, name, receiver) {
      if (typeof name !== "string" || Reflect.has(target, name)) {
        return Reflect.get(target, name, receiver);
      }
      return {
        enabled: true,
        executor: () => {
          appendAudit(ctx.config.home, {
            at: new Date().toISOString(),
            tool: name,
            kind: "read",
            status: "tool_not_found",
            inputSummary: { keys: [], bytes: 0 },
            durationMs: 0,
          });
          throw new Error(
            formatToolError(
              new ToolError(
                "tool_not_found",
                "This server does not offer a tool by that name. Call `tools/list` for the ones it does. The write tool is registered only when the operator sets RFPHUB_MCP_ENABLE_SUBMIT=1, so its absence is a configuration choice, not an error.",
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
      // Hints, not enforcement — only some clients act on them. Set anyway: a client that does
      // use them should not have to guess that a search is a read.
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
      (args) => {
        // The KIND is decided by the PHASE, inside `run`: the preview spends the preview budget and
        // the commit spends the commit budget, and only when it reaches the POST. `guard` therefore
        // spends nothing here, and learns which phase happened from the callback below so the audit
        // line names what actually occurred rather than what was expected.
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
            // CHARGED BEFORE ANY WORK, on every invocation, successful or not. The phase budgets
            // only meter calls that got somewhere; without this, refusals — a bogus approval id, a
            // document over the caps, a key hidden in a field — are free, and the refusal path is
            // an unmetered loop through validation and the filesystem.
            phaseCtx.policy.consume("attempt");
            return submitTool.run(args, phaseCtx);
          },
          { consumeBudget: false, outputSchema: submitTool.outputSchema },
        );
      },
    );
  }

  // AFTER the registrations: the SDK installs its `tools/call` dispatcher lazily, on the first
  // `registerTool`, and the seams do not exist to be wrapped until it has.
  installErrorBoundary(server, ctx);

  return server;
}

/**
 * Spend the budget (unless the tool does it itself), run, redact, audit, and turn any failure into
 * a coded error result.
 *
 * `kind` is either fixed or a thunk read AFTER the work finishes — the write tool does not know
 * which phase it is in until it gets there.
 */
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

    // OUTPUT VALIDATION HAPPENS HERE, not after this function returns. The SDK checks
    // `structuredContent` against the declared schema too — but it does so downstream, so a
    // malformed body would already have been recorded as `ok` in the audit log and would come back
    // in the SDK's own words rather than as one of this package's codes. Validating inside means a
    // 2xx whose shape is wrong fails like anything else fails.
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

/**
 * Just enough of a schema for `guard` to check a result against, so this file does not take a
 * dependency on a particular validation library's type surface.
 */
interface OutputValidator {
  safeParse(
    value: unknown,
  ):
    | { success: true }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/**
 * The ONE wire format for a coded failure: the code in brackets, then the sentence, redacted.
 *
 * Two paths produce these — `guard`, and the argument-validation wrapper that runs upstream of it —
 * and a client that branches on the code needs both to look the same.
 */
export function formatToolError(error: ToolError): string {
  return redactString(`[${error.code}] ${error.message}`);
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
