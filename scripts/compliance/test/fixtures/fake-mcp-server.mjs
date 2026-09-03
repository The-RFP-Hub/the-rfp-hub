#!/usr/bin/env node
/**
 * A stand-in MCP server for `checks/mcp.mjs`'s tests: the same newline-delimited JSON-RPC wire
 * shape `packages/mcp` speaks, with its defects chosen by `FAKE_MCP_DEFECT`.
 */
import { createInterface } from "node:readline";

const defect = process.env.FAKE_MCP_DEFECT ?? "none";
// The real server registers the write tool if and only if a credential is configured.
const submitEnabled = Boolean(process.env.RFPHUB_API_KEY);
const apiBase = process.env.RFPHUB_API_BASE ?? "";

// The real server's schemas are zod-generated and carry this dialect, which the draft-07 ajv build
// refuses to compile at all — so the fixture declares it too.
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

const searchOutputSchema = {
  $schema: DIALECT,
  type: "object",
  required: ["notice", "total", "page", "limit", "totalPages", "items"],
  properties: {
    notice: { type: "string" },
    total: { type: "number" },
    page: { type: "number" },
    limit: { type: "number" },
    totalPages: { type: "number" },
    items: {
      type: "array",
      items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  },
};

const submitOutputSchema = {
  $schema: DIALECT,
  type: "object",
  required: ["status"],
  properties: { status: { type: "string" }, approvalId: { type: "string" } },
};

function tools() {
  const read = [
    {
      name: "search_opportunities",
      description: "search",
      inputSchema: { type: "object" },
      outputSchema: searchOutputSchema,
      annotations: { readOnlyHint: defect === "read-tool-not-read-only" ? false : true, openWorldHint: true },
    },
    {
      name: "fetch_opportunity",
      description: "fetch",
      inputSchema: { type: "object" },
      ...(defect === "no-output-schema" ? {} : { outputSchema: { $schema: DIALECT, type: "object" } }),
      annotations: { readOnlyHint: true, openWorldHint: defect === "non-boolean-hint" ? "yes" : true },
    },
  ];
  if (defect === "extra-tool") {
    read.push({
      name: "debug_tool",
      description: "extra",
      inputSchema: { type: "object" },
      outputSchema: { $schema: DIALECT, type: "object" },
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
  }
  if (!submitEnabled) return read;
  return [
    ...read,
    {
      name: "submit_opportunity",
      description: "submit",
      inputSchema: { type: "object" },
      outputSchema: submitOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: defect === "destructive-submit" ? true : false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
  ];
}

async function search(args) {
  const url = `${apiBase}/v1/opportunities?q=${encodeURIComponent(args.q ?? "")}&limit=${args.limit ?? 10}&page=${args.page ?? 1}`;
  const body = await (await fetch(url)).json();
  const structured = {
    notice: "n",
    total: defect === "envelope-drift" ? body.total + 1 : body.total,
    page: body.page,
    limit: body.limit,
    totalPages: body.totalPages,
    items: (body.items ?? []).map((item) => ({ id: item.id })),
  };
  if (defect === "same-page") structured.items = [{ id: "always:the-same" }];
  // A key-shaped string in the envelope's own prose, which the id comparison never reads.
  if (defect === "leaks-in-search") structured.notice = "configured with rfph_leaked_in_notice";
  if (defect === "text-only") {
    return { content: [{ type: "text", text: JSON.stringify(structured) }] };
  }
  if (defect === "schema-drift") {
    return { structuredContent: { ...structured, total: "many" }, content: [] };
  }
  return { structuredContent: structured, content: [] };
}

class RpcError extends Error {}

async function handle(message) {
  if (message.method === "tools/list") return { tools: tools() };
  if (message.method === "tools/call") {
    const { name, arguments: args = {} } = message.params ?? {};
    if (name === "search_opportunities") {
      if (defect === "search-error-leak") {
        throw new RpcError("upstream refused the key rfph_leaked_in_error");
      }
      return await search(args);
    }
    if (name === "submit_opportunity") {
      if (defect === "writes-before-approval") {
        await fetch(`${apiBase}/v1/opportunities`, { method: "POST", body: "{}" });
      }
      return {
        structuredContent: {
          status: defect === "not-pending" ? "submitted" : "pending",
          approvalId: "a".repeat(64),
        },
        content: [],
      };
    }
    return { structuredContent: {}, content: [] };
  }
  return {};
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  handle(message).then(
    (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`),
    (err) =>
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(err) } })}\n`,
      ),
  );
});

// A server that logs its configuration on the way out: the surface a leak scan taken while the
// process is still running would miss entirely.
process.on("SIGTERM", () => {
  if (defect === "leaks-on-exit") {
    process.stderr.write("shutting down, key was rfph_leaked_on_exit\n");
  }
  process.exit(0);
});
