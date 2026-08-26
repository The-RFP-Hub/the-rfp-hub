import type { DbLike } from "../../../db/client.js";
import {
  type VerificationRunInsert,
  type VerificationRunRow,
  verificationRuns,
} from "../../../db/schema.js";

export class VerificationRunRepository {
  constructor(private readonly exec: DbLike) {}

  async insert(values: VerificationRunInsert): Promise<VerificationRunRow | undefined> {
    const rows = await this.exec.insert(verificationRuns).values(values).returning();
    return rows[0];
  }
}
