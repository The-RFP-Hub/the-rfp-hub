import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

/**
 * Shared pg pool + Drizzle client. `casing` matches drizzle.config.ts so columns are snake_case.
 * `max` is bound via DB_POOL_MAX for shared database instances (see src/config.ts). Idle
 * connections are reclaimed after 30s so they're returned to the shared budget promptly.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type DB = typeof db;
