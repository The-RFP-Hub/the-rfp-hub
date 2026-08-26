import type { DB, DbLike } from "../../db/client.js";

/**
 * The first repository seam. Domain query methods arrive here as services are migrated; until then
 * it has no query surface and keeps its executor private from service callers.
 */
export class OpportunityRepository {
  constructor(private readonly exec: DbLike) {}

  /** Keeps the executor owned by the repository without exposing it to service callers. */
  protected executor(): DbLike {
    return this.exec;
  }
}

/** The repositories a service may compose. Add domain repositories here as migrations land. */
export interface Repositories {
  readonly opportunities: OpportunityRepository;
}

/** Build one executor-bound bundle. Repositories are constructed only when first requested. */
export function repositories(exec: DbLike): Repositories {
  let opportunities: OpportunityRepository | undefined;

  return {
    get opportunities() {
      opportunities ??= new OpportunityRepository(exec);
      return opportunities;
    },
  };
}

/**
 * Run work atomically while exposing only executor-bound repositories. The raw transaction handle
 * never crosses this boundary, so every read and write in `run` stays on the held connection.
 */
export function withTransaction<T>(
  db: DB,
  run: (repos: Repositories) => Promise<T> | T,
): Promise<T> {
  return db.transaction((tx) => Promise.resolve(run(repositories(tx))));
}
