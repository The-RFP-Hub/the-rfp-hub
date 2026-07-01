import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

/** Shared pg pool + Drizzle client. `casing` matches drizzle.config.ts so columns are snake_case. */
export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type DB = typeof db;
