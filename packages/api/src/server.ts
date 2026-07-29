import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";

const app = await buildApp({ logger: true });

// The pg pool is a module-level singleton shared with the services (see db/client.ts) — it has no
// lifecycle of its own, so tie it to the server's Fastify instance here rather than in buildApp(),
// which the integration tests also use and close/end the pool themselves.
app.addHook("onClose", async () => {
  await pool.end();
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`RFP Hub API on http://${config.host}:${config.port} — docs at /v1/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown: stop accepting new connections, let in-flight requests finish, close the DB
// pool (via the onClose hook above), then exit. A forced timeout guards against a hung close (e.g.
// a stuck connection) so the process is never left un-killable — SIGTERM/SIGINT deserve a real exit.
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`${signal} received, shutting down`);

  const forceExit = setTimeout(() => {
    app.log.error(
      `graceful shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await app.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    clearTimeout(forceExit);
    app.log.error(err);
    process.exit(1);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
