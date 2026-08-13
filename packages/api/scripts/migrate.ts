/** Apply pending Drizzle migrations from src/db/migrations against DATABASE_URL. */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "../src/config.js";

/**
 * The migrations directory, resolved from THIS MODULE rather than from the working directory.
 *
 * A relative `./src/db/migrations` only found the files when the process happened to start in
 * `packages/api`, which is true of `pnpm --filter … migrate` and false of every other caller. The
 * built entry point (`dist/migrate.js`) and this source file (`scripts/migrate.ts`) both sit one
 * level below the package root, so one relative URL locates the folder from either — and the same
 * command works from the repo root, from a container's `/app`, or from anywhere else.
 */
const migrationsFolder = fileURLToPath(new URL("../src/db/migrations", import.meta.url));

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);

await migrate(db, { migrationsFolder });
await pool.end();

console.log("✓ migrations applied");
