import { type DB, db as defaultDb } from "../../../db/client.js";
import { type Repositories, repositories } from "../../repositories/index.js";

/** Liveness + DB readiness probe for `/v1/health`. */
export class HealthService {
  private readonly repos: Repositories;

  constructor(db: DB = defaultDb) {
    this.repos = repositories(db);
  }

  /** True when the database answers a trivial query, false otherwise. */
  async ping(): Promise<boolean> {
    try {
      await this.repos.system.ping();
      return true;
    } catch {
      return false;
    }
  }
}
