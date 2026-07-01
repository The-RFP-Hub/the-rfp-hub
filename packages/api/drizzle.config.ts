import { defineConfig } from "drizzle-kit";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rfphub:rfphub@localhost:5432/rfphub";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: DATABASE_URL },
  casing: "snake_case",
});
