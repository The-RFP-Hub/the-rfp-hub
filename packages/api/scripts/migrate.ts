/** Apply pending Drizzle migrations from src/db/migrations against DATABASE_URL. */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "../src/config.js";

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./src/db/migrations" });
await pool.end();

console.log("✓ migrations applied");
