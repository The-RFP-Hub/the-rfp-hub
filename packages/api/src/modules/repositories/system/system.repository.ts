import { sql } from "drizzle-orm";
import type { DbLike } from "../../../db/client.js";
import { datasetSnapshots } from "../../../db/schema.js";

export interface DatasetSnapshotInsert {
  format: string;
  entryCount: number;
  url: string;
  sha256: string;
  specVersion: string;
}

/** Database operations that belong to the running system rather than a domain aggregate. */
export class SystemRepository {
  constructor(private readonly exec: DbLike) {}

  /** Resolve only after the database has answered a trivial query. */
  async ping(): Promise<void> {
    await this.exec.execute(sql`SELECT 1`);
  }

  /** Record the immutable archive artifacts produced by one completed export run. */
  async recordDatasetSnapshots(values: DatasetSnapshotInsert[]): Promise<void> {
    if (values.length === 0) return;
    await this.exec.insert(datasetSnapshots).values(values);
  }
}
