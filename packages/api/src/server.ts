import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`RFP Hub API on http://${config.host}:${config.port} — docs at /v1/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
