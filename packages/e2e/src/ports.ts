/**
 * Host ports for the Node-hosted children.
 *
 * Postgres does NOT go through here: it binds `127.0.0.1::5432` and the runner reads the mapping
 * back with `docker compose port` (see `postgres.ts`), which has no TOCTOU window at all. That is
 * the better mechanism and it is used wherever it is available.
 *
 * It is not available for the API or the dashboard, because neither can be told "bind port 0 and
 * tell me what you got": `packages/api/src/config.ts` reads `PORT` and silently falls back to 3001
 * for anything it cannot parse as a usable port — handing it `0` would quietly put the API on the
 * developer's own dev port — and `next dev --port 0` picks a port this process would then have to
 * scrape out of a log line. So the runner reserves a port the only way left: bind it, read it,
 * release it, hand the number over, and RETRY when the child loses the race. The race window is
 * milliseconds wide and the retry closes it; pretending it does not exist would not.
 */
import { createServer } from "node:net";

const ATTEMPTS = 5;

/** Binds an ephemeral port on 127.0.0.1, reads its number, releases it, and returns the number. */
function probeOnce(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("ports: no TCP port assigned")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** True when nothing is listening on the port right now. */
export function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * A port for a child to bind, distinct from every port already handed out in this run.
 *
 * `taken` is passed in rather than kept in module state so the caller — which knows the whole
 * run's allocation — stays the single authority, and so two runs in one process (the check-m3
 * boot, say) cannot leak allocations into each other.
 */
export async function reserve(taken: Set<number> = new Set()): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const port = await probeOnce();
      if (taken.has(port)) continue;
      if (!(await isFree(port))) continue;
      taken.add(port);
      return port;
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `ports: could not reserve a free 127.0.0.1 port in ${ATTEMPTS} attempts${detail}`,
  );
}
