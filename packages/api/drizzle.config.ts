import { defineConfig } from "drizzle-kit";

/**
 * Same dev/test fallback as src/config.ts, and announced for the same reason: nothing in this repo
 * loads a .env file, so an unset DATABASE_URL means drizzle-kit reads and writes localhost — not
 * wherever a .env was meant to point it. Duplicated rather than imported because drizzle-kit loads
 * this file on its own, outside the API's build.
 */
if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL unset — using the local docker-compose default postgres://rfphub@localhost:5432/rfphub (nothing here loads a .env file; export DATABASE_URL to point elsewhere).",
  );
}

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rfphub:rfphub@localhost:5432/rfphub";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: DATABASE_URL },
  casing: "snake_case",
});
