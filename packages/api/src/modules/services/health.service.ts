import { sql } from "drizzle-orm";
import { type DB, db as defaultDb } from "../../db/client.js";

/** Liveness + DB readiness probe for `/v1/health`. */
export class HealthService {
  constructor(private readonly db: DB = defaultDb) {}

  /** True when the database answers a trivial query, false otherwise. */
  async ping(): Promise<boolean> {
    try {
      await this.db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }
}
