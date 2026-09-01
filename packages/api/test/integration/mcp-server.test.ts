/**
 * The published MCP server, driven as a real process against this API and a real database.
 *
 * Every other test of that package injects `fetch`. This one does not: it starts the API on a
 * loopback port, spawns `packages/mcp/dist/cli.js` — the file the npm package's `bin` points at —
 * and speaks JSON-RPC to its stdin. What it proves is the set of claims a stub cannot: that the
 * tool list a client sees is exactly two or exactly three, that the search tool forwards a query
 * and paginates the way the endpoint does, and that the three-phase write really does leave the
 * owner's own listing untouched until a person approves at a terminal.
 *
 * THE OWNER LISTING IS THE ORACLE, not the public one. A pending entry is invisible to
 * `GET /v1/opportunities` whether it exists or not, so proving "nothing was written" against the
 * public read proves nothing at all.
 *
 * Isolation tag: `M4MCP` / `m4mcp:`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Opportunity } from "@the-rfp-hub/standard";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { OpportunityService } from "../../src/modules/services/opportunities/opportunity.service.js";
import { mintApiKeyFor, seedIdentity, seedOrganization, testAuth } from "../helpers/auth.js";
import { cleanupFixtures } from "../helpers/cleanup.js";
import { submission } from "../helpers/opportunity-fixture.js";
import { describeWithDb } from "./db-gate.js";

const NS = "m4mcp";
const TAG = "M4MCP";
/** A word no corpus row contains, so `q` selects exactly this suite's rows. */
const NEEDLE = "zylotronic";
const EMAIL = "m4mcp-submitter@rfphub.invalid";
const SUBMITTED_ID = `${NS}:submitted-through-mcp`;

const CLI = path.resolve(import.meta.dirname, "../../../mcp/dist/cli.js");

const LISTED: Opportunity[] = ["one", "two", "three"].map(
  (local, index) =>
    ({
      specVersion: "1.0.0",
      id: `${NS}:${local}`,
      fundingType: "grant",
      title: `Zylotronic ${local} program`,
      description: `Fixture ${index} for the MCP integration suite.`,
      status: "open",
      operatingOrganizations: [{ name: "M4 MCP Fixture Org", slug: NS }],
      source: { ingestedVia: "import", verifiedAgainstSource: null },
      ecosystems: [TAG],
      fundingInfo: { minAward: 1_000, maxAward: 5_000, currency: "USD" },
      fundingDetails: { fundingType: "grant" },
    }) as Opportunity,
);

interface Session {
  child: ChildProcessWithoutNullStreams;
  send(message: unknown): Promise<Record<string, unknown>>;
  stop(): void;
}

interface ToolResult {
  content?: { text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const run = describeWithDb;

run("M4MCP the MCP server against the real API", () => {
  let app: FastifyInstance;
  let base: string;
  let home: string;
  let apiKey: string;
  let sessionToken: string;
  const userIds: string[] = [];

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      RFPHUB_API_BASE: base,
      RFPHUB_MCP_HOME: home,
      ...extra,
    };
  }

  /** Spawn the built executable and drive it line by line over its own stdio. */
  function session(extra: Record<string, string> = {}): Session {
    const child = spawn(process.execPath, [CLI], { env: env(extra), stdio: "pipe" });
    const waiting: ((line: Record<string, unknown>) => void)[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line.length > 0) waiting.shift()?.(JSON.parse(line) as Record<string, unknown>);
        at = buffer.indexOf("\n");
      }
    });
    return {
      child,
      send(message) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no MCP response in 20s")), 20_000);
          waiting.push((line) => {
            clearTimeout(timer);
            resolve(line);
          });
          child.stdin.write(`${JSON.stringify(message)}\n`);
        });
      },
      stop() {
        child.kill();
      },
    };
  }

  async function callTool(
    s: Session,
    name: string,
    args: Record<string, unknown>,
    id = 1,
  ): Promise<ToolResult> {
    const reply = await s.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return (reply.result ?? {}) as ToolResult;
  }

  async function toolNames(extra: Record<string, string> = {}): Promise<string[]> {
    const s = session(extra);
    try {
      const reply = await s.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      return (reply.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
    } finally {
      s.stop();
    }
  }

  /** The CLI's approval mode, answered on stdin the way a person answers it. */
  function approve(approvalId: string): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "approve", approvalId], {
        env: env({ RFPHUB_API_KEY: apiKey, RFPHUB_MCP_ENABLE_SUBMIT: "1" }),
        stdio: "pipe",
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("exit", (code) => resolve({ code, out }));
      child.stdin.end("approve\n");
    });
  }

  async function get(pathname: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${pathname}`, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** The owner's own listing — the only view in which a pending entry is visible. */
  async function ownedIds(): Promise<string[]> {
    const { status, body } = await get("/v1/me/opportunities?limit=100", {
      authorization: `Bearer ${sessionToken}`,
    });
    expect(status).toBe(200);
    return (body.items as { id: string }[]).map((item) => item.id);
  }

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(
        `the MCP package is not built (${CLI}). Run \`pnpm --filter @the-rfp-hub/mcp build\`; CI's build step does this before the suite.`,
      );
    }
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rfphub-mcp-integration-"));

    const identity = await seedIdentity(EMAIL, { handle: "m4mcp-submitter" });
    userIds.push(identity.userId);
    sessionToken = identity.token;
    // Unverified, and the submitter is not a member: a `write` key submitting here lands PENDING,
    // which is the state the interlock is worth having for.
    await seedOrganization({ slug: NS, name: "M4 MCP Fixture Org", verified: false });
    apiKey = await mintApiKeyFor(identity.account.id, ["read", "write"]);

    const service = new OpportunityService();
    for (const document of LISTED) {
      await service.upsertFromStandard(document, { reviewStatus: "approved", isListed: true });
    }

    app = await buildApp({ auth: { auth: await testAuth() } });
    await app.ready();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (address === null || typeof address === "string") throw new Error("the API did not listen");
    base = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await cleanupFixtures({
      opportunityPrefix: NS,
      organizationSlugs: [NS],
      userIds,
      emails: [EMAIL],
      handles: ["m4mcp-submitter"],
    });
    await app?.close();
    await pool.end();
    fs.rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it("offers exactly two tools, and exactly three when the write flag is set", async () => {
    expect(await toolNames()).toEqual(["fetch_opportunity", "search_opportunities"]);
    expect(await toolNames({ RFPHUB_MCP_ENABLE_SUBMIT: "1", RFPHUB_API_KEY: apiKey })).toEqual([
      "fetch_opportunity",
      "search_opportunities",
      "submit_opportunity",
    ]);
  });

  it("forwards the query and paginates exactly as GET /v1/opportunities does", async () => {
    const s = session();
    try {
      for (const page of [1, 2]) {
        const direct = await get(`/v1/opportunities?q=${NEEDLE}&limit=2&page=${page}`);
        expect(direct.status).toBe(200);
        const expected = (direct.body.items as { id: string }[]).map((item) => item.id);
        expect(expected.length).toBeGreaterThan(0);

        const result = await callTool(
          s,
          "search_opportunities",
          { q: NEEDLE, limit: 2, page },
          page,
        );
        const structured = result.structuredContent as {
          items: { id: string }[];
          total: number;
          page: number;
          limit: number;
          totalPages: number;
        };
        expect(result.isError).toBeUndefined();
        expect(structured.items.map((item) => item.id)).toEqual(expected);
        expect(structured.total).toBe(direct.body.total);
        expect(structured.page).toBe(direct.body.page);
        expect(structured.limit).toBe(direct.body.limit);
        expect(structured.totalPages).toBe(direct.body.totalPages);
      }
      // Two pages of one query, and the fixtures really did span both.
      expect(LISTED.length).toBeGreaterThan(2);
    } finally {
      s.stop();
    }
  }, 30_000);

  it("fetches one record by the id the search returned", async () => {
    const s = session();
    try {
      const result = await callTool(s, "fetch_opportunity", { id: `${NS}:one` });
      expect(result.isError).toBeUndefined();
      const envelope = result.structuredContent as { opportunity: { id: string; title: string } };
      expect(envelope.opportunity.id).toBe(`${NS}:one`);
      expect(envelope.opportunity.title).toBe("Zylotronic one program");
    } finally {
      s.stop();
    }
  }, 30_000);

  it("previews, refuses an unapproved commit, and writes only after a terminal approval", async () => {
    const document = submission(SUBMITTED_ID, NS, {
      title: "Submitted through the MCP server",
      ecosystems: [TAG],
    });
    const s = session({ RFPHUB_MCP_ENABLE_SUBMIT: "1", RFPHUB_API_KEY: apiKey });
    try {
      expect(await ownedIds()).not.toContain(SUBMITTED_ID);

      const preview = await callTool(s, "submit_opportunity", { document }, 1);
      expect(preview.isError).toBeUndefined();
      const pending = preview.structuredContent as { status: string; approvalId: string };
      expect(pending.status).toBe("pending");
      expect(pending.approvalId).toMatch(/^[0-9a-f]{64}$/);
      // THE PREVIEW WROTE NOTHING. Asserted against the owner listing, where a pending entry would
      // be visible if one existed.
      expect(await ownedIds()).not.toContain(SUBMITTED_ID);

      const early = await callTool(
        s,
        "submit_opportunity",
        { document, approvalId: pending.approvalId },
        2,
      );
      expect(early.isError).toBe(true);
      expect(early.content?.[0]?.text).toContain("[confirmation_required]");
      expect(await ownedIds()).not.toContain(SUBMITTED_ID);

      const approval = await approve(pending.approvalId);
      expect(approval.code, approval.out).toBe(0);
      expect(approval.out).toContain(`Approved ${pending.approvalId}`);

      const committed = await callTool(
        s,
        "submit_opportunity",
        { document, approvalId: pending.approvalId },
        3,
      );
      expect(committed.isError, committed.content?.[0]?.text).toBeUndefined();
      const submitted = committed.structuredContent as {
        status: string;
        id: string;
        reviewStatus: string;
      };
      expect(submitted.status).toBe("submitted");
      expect(submitted.id).toBe(SUBMITTED_ID);
      expect(submitted.reviewStatus).toBe("pending");

      expect(await ownedIds()).toContain(SUBMITTED_ID);
      // And still nowhere on the public surface, which is why the owner route is the oracle: a
      // pending entry is 404 there whether it exists or not.
      const publicRead = await get(`/v1/opportunities/${SUBMITTED_ID}`);
      expect(publicRead.status).toBe(404);
    } finally {
      s.stop();
    }
  }, 60_000);
});
