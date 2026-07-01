import { type DB, db as defaultDb } from "../../db/client.js";

/**
 * Base for the data + business-logic classes (the "controller" layer over the DB).
 * Holds the Drizzle handle; the DB is injectable so integration tests can point at a test database.
 * Concrete controllers (Opportunity, Stats) implement their own typed queries over `this.db`.
 */
export abstract class DrizzleController {
  protected readonly db: DB;

  constructor(database: DB = defaultDb) {
    this.db = database;
  }

  /** Clamp pagination to safe bounds and compute the SQL offset. */
  protected paginate(page = 1, limit = 20): { page: number; limit: number; offset: number } {
    const p = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const l = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
    return { page: p, limit: l, offset: (p - 1) * l };
  }
}
