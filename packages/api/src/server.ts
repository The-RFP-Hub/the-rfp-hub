import { buildApp } from "./app.js";
import { config } from "./config.js";

// The pg pool is a module-level singleton shared with the services (see db/client.ts) and has no
// lifecycle of its own, so the SERVER owns it — the integration suites end it themselves after
// their own cleanup, which is why this is a flag rather than something buildApp always does.
//
// It is passed IN rather than registered out here as an `onClose` hook of its own: Fastify runs
// those hooks LIFO, so a hook added after `buildApp` returned would run before the analytics buffer
// had drained, and the shutdown flush would write into a closed pool. `buildApp` registers both, in
// order, for exactly that reason.
const app = await buildApp({ logger: true, closePool: true });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`RFP Hub API on http://${config.host}:${config.port} — docs at /v1/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown: stop accepting new connections, let in-flight requests finish, close the DB
// pool (via the onClose hook above), then exit. Without this a SIGTERM kills the process mid-request
// and leaves the pool's connections to time out server-side. The forced timeout guards against a
// hung close (a stuck connection, say) so the process can never be left un-killable.
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
