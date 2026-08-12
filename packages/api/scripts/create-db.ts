/**
 * Create the database named in DATABASE_URL if it doesn't exist yet.
 *
 * Postgres can't create a database from a connection to itself, so this
 * connects to the instance's maintenance database (`postgres`) with the same
 * credentials and issues CREATE DATABASE from there. Idempotent — safe to run
 * before every `pnpm migrate`.
 */
import pg from "pg";
import { config } from "../src/config.js";

const target = new URL(config.databaseUrl);
const dbName = target.pathname.replace(/^\//, "");
if (!dbName) {
  console.error("DATABASE_URL has no database name in its path");
  process.exit(1);
}

const admin = new URL(config.databaseUrl);
admin.pathname = "/postgres";

const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();

const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
if (exists.rowCount) {
  console.log(`✓ database "${dbName}" already exists`);
} else {
  // CREATE DATABASE can't take bind parameters; dbName comes from our own
  // connection string, quoted defensively anyway.
  await client.query(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`);
  console.log(`✓ database "${dbName}" created`);
}

await client.end();
