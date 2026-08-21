import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

/**
 * Shared pg pool + Drizzle client. `casing` matches drizzle.config.ts so columns are snake_case.
 * `max` is bound via DB_POOL_MAX (see src/config.ts): this service shares a database instance with
 * others, so an unbounded pool is not a neutral default — it takes connection budget from its
 * neighbours. Idle connections are reclaimed after 30s so they return to that shared budget
 * promptly instead of being held for the process's lifetime.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type DB = typeof db;

/**
 * The handle a `db.transaction(...)` callback receives.
 *
 * Named here because the M3 write paths hand it down: an audit row is written by the audit service
 * with the SAME handle that wrote the mutation, so a rolled-back mutation can never leave a
 * history row claiming it happened. A service that takes `DbLike` works on either.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the pool-backed client or an open transaction. */
export type DbLike = DB | Tx;
