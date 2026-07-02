import { sql } from "drizzle-orm";
import { DrizzleController } from "../abstract/Drizzle.controller.js";

/** Liveness + DB readiness probe for `/v1/health`. */
export class HealthController extends DrizzleController {
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
