/**
 * A local recording HTTP server, used ONLY for the `submit_opportunity` fail-closed assertion in
 * checks/mcp.mjs (§4 case 4, the "phase 1 performs no network write" case).
 *
 * The plan is explicit that this case cannot be verified against the real API — `GET
 * /v1/me/opportunities` needs a real credential, and the synthetic key
 * (`RFPHUB_API_KEY=rfph_test_notreal`) is not one — "instead run this case ONLY against a local
 * mock or assert the tool output and that no POST was attempted using an `RFPHUB_API_BASE`
 * pointing to a local recording HTTP server started by the checker." This is that server: it
 * accepts anything, on any path and method, records the request, and answers fast so the MCP
 * server under test never blocks on it.
 */
import { createServer } from "node:http";

export class RecordingServer {
  #server;
  #requests = [];

  async start() {
    this.#server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        this.#requests.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: Buffer.concat(chunks).toString("utf8"),
          receivedAt: new Date().toISOString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ items: [], total: 0 }));
      });
    });
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    this.origin = `http://127.0.0.1:${address.port}`;
    return this.origin;
  }

  /** Every request received so far, in order. */
  get requests() {
    return this.#requests;
  }

  /** Requests that were not a plain read — anything other than GET/HEAD. */
  get writeRequests() {
    return this.#requests.filter((r) => !["GET", "HEAD"].includes(r.method));
  }

  async stop() {
    await new Promise((resolve) => this.#server.close(resolve));
  }
}
