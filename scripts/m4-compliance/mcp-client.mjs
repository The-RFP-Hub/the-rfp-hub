/**
 * A minimal MCP client over stdio — just enough to drive `tools/list` and `tools/call`.
 *
 * Hand-rolled because neither `@modelcontextprotocol/client` nor the server SDK is a dependency of
 * this repo or this checker, and adding one would be a second thing to keep in sync with whatever
 * `packages/mcp` ends up depending on. The wire format is newline-delimited JSON-RPC 2.0 — no
 * `Content-Length` framing, that is LSP's convention — and protocol revision `2026-07-28` is
 * stateless, so there is no `initialize` handshake to perform. A server that still expects one
 * answers with a JSON-RPC error or times out, and the caller reports that verbatim rather than
 * silently retrying with a different protocol.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * `base` merged with `env`, then every name in `unset` deleted — in that order, so `unset` wins
 * even over an explicit `env` entry. That ordering is the guarantee: the read-only case must
 * actively STRIP `RFPHUB_API_KEY`/`RFPHUB_MCP_ENABLE_SUBMIT`, not merely decline to set them.
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

    // ENOENT arrives here, never as an exit: without this listener it was an unhandled 'error'
    // event that took the whole run down.
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
      // Nothing still waiting will be answered now: fail it with the exit reason.
      for (const [, pending] of this.#pending) {
        pending.reject(
          new Error(
            `MCP server exited before answering (code=${code}, signal=${signal}). stderr:\n${this.#stderr.slice(-2000)}`,
          ),
        );
      }
      this.#pending.clear();
    });

    // `close`, not `exit`: it fires once the stdio streams have ended, so a caller scanning
    // `stderr` afterwards has the child's LAST line.
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
      // The plan requires nothing but the protocol on stdout, so a non-JSON line is kept for
      // callers to assert on rather than silently swallowed.
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
   * Terminate and AWAIT the exit, so a caller scanning `stderr` afterwards sees what the child
   * wrote on its way out. SIGKILL if it ignores SIGTERM, so one server cannot hang the run.
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

/** Any `rfph_`-shaped substring anywhere in a value — the assertion that no MCP surface leaks one. */
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
