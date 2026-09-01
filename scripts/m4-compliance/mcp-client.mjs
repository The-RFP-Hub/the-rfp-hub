/**
 * A minimal MCP client over stdio — just enough to drive `tools/list` and `tools/call`.
 *
 * WHY HAND-ROLLED. The M4 plan pins the server to MCP protocol revision `2026-07-28`, spoken by
 * `@modelcontextprotocol/server@2.0.0` / `@modelcontextprotocol/client`. Neither is a dependency of
 * this repo (`packages/mcp` is being built by another stream) or of this checker, and installing a
 * client SDK here just to drive a handful of requests would be a second thing to keep in sync with
 * whatever `packages/mcp` actually ends up depending on. So: if `@modelcontextprotocol/client` is
 * resolvable at run time (from this package's own `node_modules`, or from `packages/mcp`'s once it
 * exists), a future revision of this file can prefer it. Absent that, this client speaks the wire
 * format directly:
 *
 *   - **Transport**: newline-delimited JSON-RPC 2.0 over stdin/stdout. No `Content-Length` framing
 *     (that is LSP's convention, not MCP's) — one complete JSON value per line, in each direction.
 *   - **No `initialize` handshake.** Revision `2026-07-28` is stateless per the plan: there is no
 *     `initialize`/`initialized` exchange and no `Mcp-Session-Id`. This client goes straight to
 *     `tools/list` / `tools/call`. If a server under test still expects the older handshake (e.g.
 *     it was built against an earlier SDK before the D1 confirmation in the plan landed), the first
 *     request will come back as a JSON-RPC error or simply time out, and the caller reports that
 *     verbatim rather than silently retrying with a different protocol.
 *
 * Every method here is a thin RPC call; the tool-shaped assertions (which ids came back, whether
 * `submit_opportunity` is present, whether `rfph_` leaked) live in `checks/mcp.mjs`, which is the
 * part that actually knows what the contract means.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * The child's environment: `base` (normally `process.env`) merged with `env`, then every name in
 * `unset` deleted — in that order, so `unset` always wins even over an explicit `env` entry.
 * Pulled out of `McpStdioClient.start()` as a pure function so the guarantee behind item 7 (the
 * read-only MCP case must not merely "not set" `RFPHUB_API_KEY`/`RFPHUB_MCP_ENABLE_SUBMIT`, but
 * actively strip them from whatever the checker's own process inherited) is unit-testable without
 * spawning a process.
 */
export function buildChildEnv(base, env = {}, unset = []) {
  const merged = { ...base, ...env };
  for (const key of unset) delete merged[key];
  return merged;
}

export class McpStdioClient {
  #child;
  #rl;
  #pending = new Map();
  #nextId = 1;
  #stderr = "";
  #resolveExited;
  #closed = false;
  #exitInfo = null;
  #spawnError = null;
  #exited;

  /**
   * `unset`: environment variable NAMES to remove from the child's environment even if this
   * checker's own process happens to have them set (a developer's shell exporting
   * `RFPHUB_API_KEY` for unrelated reasons, say). Applied AFTER merging `process.env` with `env`,
   * so it always wins — the read-only case in `checks/mcp.mjs` uses this to guarantee the
   * "default env, read-only tools only" case is actually tested with no credential and no submit
   * flag present, rather than merely not-explicitly-setting them and hoping the ambient
   * environment agrees.
   */
  constructor(command, args = [], { env = {}, cwd, unset = [] } = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.unset = unset;
  }

  /** Spawn the child process and start reading its stdout. Does NOT send any request. */
  start() {
    this.#exited = new Promise((resolve) => {
      this.#resolveExited = resolve;
    });
    this.#child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: buildChildEnv(process.env, this.env, this.unset),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#rl = createInterface({ input: this.#child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    this.#rl.on("line", (line) => this.#onLine(line));

    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString("utf8");
    });

    // ENOENT (no `npx`, no `node`, a mistyped binary) arrives here, never as an exit — without
    // this listener it surfaced as an unhandled 'error' event that took the whole run down.
    this.#child.on("error", (err) => {
      this.#closed = true;
      this.#spawnError = err;
      for (const [, pending] of this.#pending) {
        pending.reject(new Error(`MCP server could not be started: ${err.message}`));
      }
      this.#pending.clear();
    });

    this.#child.on("exit", (code, signal) => {
      this.#closed = true;
      this.#exitInfo = { code, signal };
      // Any request still waiting will never get a response now — fail it with the exit reason
      // rather than hanging until its own timeout.
      for (const [, pending] of this.#pending) {
        pending.reject(
          new Error(
            `MCP server exited before answering (code=${code}, signal=${signal}). stderr:\n${this.#stderr.slice(-2000)}`,
          ),
        );
      }
      this.#pending.clear();
    });

    // `close` rather than `exit`: it fires once every stdio stream has ended too, so a caller
    // scanning `stderr` after this resolves has the child's LAST line, not most of them.
    this.#child.on("close", () => this.#resolveExited?.());

    this.startedAt = Date.now();
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Not every line on stdout has to be a JSON-RPC message in a server that logs to stdout by
      // mistake — but the plan requires "nothing but the protocol on stdout", so callers that care
      // read `stdoutNonJsonLines` rather than this silently swallowing it.
      this.stdoutNonJsonLines ??= [];
      this.stdoutNonJsonLines.push(trimmed);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return; // notification, or a response to a request we gave up on
    this.#pending.delete(message.id);
    pending.resolve(message);
  }

  /** One JSON-RPC request; resolves with the full response envelope (`result` or `error`). */
  async request(method, params, { timeoutMs = 15000 } = {}) {
    if (this.#spawnError) {
      throw new Error(`MCP server could not be started: ${this.#spawnError.message}`);
    }
    if (this.#closed) {
      throw new Error(
        `MCP server already exited (code=${this.#exitInfo?.code}, signal=${this.#exitInfo?.signal})`,
      );
    }
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async listTools(options) {
    return this.request("tools/list", {}, options);
  }

  async callTool(name, args, options) {
    return this.request("tools/call", { name, arguments: args }, options);
  }

  get stderr() {
    return this.#stderr;
  }

  get exitInfo() {
    return this.#exitInfo;
  }

  /**
   * Terminate and AWAIT the exit, so a caller that scans `stderr` afterwards sees everything the
   * child wrote on its way out — a shutdown path that logs configuration is exactly the surface a
   * scan taken while the process was still running would miss. SIGTERM first; SIGKILL if the child
   * ignores it, so one unresponsive server cannot hang the whole run.
   */
  async close({ graceMs = 2000 } = {}) {
    if (this.#spawnError) return;
    if (this.#closed) {
      this.#rl?.close();
      return;
    }
    this.#rl?.close();
    this.#child?.kill("SIGTERM");
    const killed = await Promise.race([
      this.#exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (killed) return;
    this.#child?.kill("SIGKILL");
    await Promise.race([
      this.#exited,
      new Promise((resolve) => setTimeout(resolve, Math.min(graceMs, 1000))),
    ]);
  }
}

/**
 * Recursively search a value for a `rfph_` credential-shaped substring, in keys or string values.
 * Used to assert that no MCP surface (tool output, error text, structuredContent) ever leaks one.
 */
export function findCredentialLeak(value, path = "$") {
  const pattern = /rfph_[A-Za-z0-9_-]{4,}/;
  if (typeof value === "string") {
    const match = pattern.exec(value);
    return match ? { path, match: match[0] } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findCredentialLeak(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      const found = findCredentialLeak(v, `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return null;
}
