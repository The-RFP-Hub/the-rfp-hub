/**
 * THE DUPLICATE READ SURFACES NAME THE COLUMNS THEY RENDER, and nothing else.
 *
 * The production defect this exists for: all three reads selected the WHOLE
 * `opportunity_duplicates` row, so they depended on `rules_key` — a column added for the resweep
 * arm's cursor, compared for equality by a job and shown to nobody. When the deployment ran ahead
 * of its own migration and the column was absent, `GET /v1/opportunities/{id}/duplicates` answered
 * 500 for EVERY entry in the corpus, including the ones with no pairs at all: the SELECT failed
 * before a row was ever mapped, so no amount of defensiveness in the mapper could have helped.
 *
 * A read that names its columns cannot be broken by a column it does not read. That is the
 * invariant here, and the SQL is the only place it is observable — a fixture with the column
 * present proves nothing.
 *
 * HOW THE SQL IS OBSERVED. The repository methods are `async` and return the builder, so awaiting
 * one executes it; there is no seam that hands back the statement. So the executor handed to the
 * repository is drizzle's own `QueryBuilder` — the real dialect, the real schema, the real
 * `casing` the client is configured with — wrapped in a proxy that answers `then` with an empty
 * result set after recording `toSQL()`. Everything under test is the repository's own query.
 */
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { DbLike } from "../../src/db/client.js";
import { DuplicatePairRepository } from "../../src/modules/repositories/opportunities/duplicate-pair.repository.js";
import type { Principal } from "../../src/modules/shared/capabilities.js";

/** The bookkeeping column no read surface renders — and the one the outage turned on. */
const BOOKKEEPING = "rules_key";

/** Every pair column the two published duplicate views actually put in a response body. */
const RENDERED = ["similarity", "signal", "status", "detected_at"];

/**
 * Run one repository read and return the statement it would have issued.
 *
 * `casing: "snake_case"` matches `src/db/client.ts`; without it the builder emits the TypeScript
 * property names and the assertions below would be testing a spelling the API never sends.
 */
async function sqlOf(read: (repo: DuplicatePairRepository) => Promise<unknown>): Promise<string> {
  const builder = new QueryBuilder({ casing: "snake_case" });
  let statement: string | undefined;

  const capture = (node: object): object =>
    new Proxy(node, {
      get(target, property, receiver) {
        if (property === "then") {
          return (resolve: (rows: unknown[]) => void) => {
            statement = (target as { toSQL(): { sql: string } }).toSQL().sql;
            resolve([]);
          };
        }
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = value.apply(target, args);
          return typeof next === "object" && next !== null ? capture(next) : next;
        };
      },
    });

  const exec = {
    select: (...args: unknown[]) =>
      capture((builder.select as (...a: unknown[]) => object).apply(builder, args)),
  } as unknown as DbLike;

  await read(new DuplicatePairRepository(exec));
  if (statement === undefined) throw new Error("the read issued no statement");
  return statement;
}

/** A caller `listForOwner` can build its ownership predicate from: submitter plus one namespace. */
const PRINCIPAL: Principal = {
  accountId: 1,
  credentialKind: "session",
  role: "submitter",
  directCreate: false,
  scopes: [],
  memberships: [{ slug: "example-org", verified: true }],
};

const READS: [string, (repo: DuplicatePairRepository) => Promise<unknown>][] = [
  ["listForOpportunity", (repo) => repo.listForOpportunity(1)],
  ["listForOwner", (repo) => repo.listForOwner(PRINCIPAL, 100)],
  ["listForReview", (repo) => repo.listForReview("suspected", 50)],
];

describe("the duplicate read surfaces select only what they render", () => {
  for (const [name, read] of READS) {
    it(`${name} does not select ${BOOKKEEPING}`, async () => {
      // THE REGRESSION. Against `select({ pair: opportunityDuplicates, … })` this fails, because
      // the whole row — bookkeeping included — is what the statement asks for.
      expect(await sqlOf(read)).not.toContain(BOOKKEEPING);
    });

    it(`${name} still selects every rendered pair column`, async () => {
      // The other half: narrowing a select is only correct while it keeps naming the fields the
      // published components declare, so this fails on an over-eager trim rather than rewarding it.
      const statement = await sqlOf(read);
      for (const column of RENDERED) {
        expect(statement, `${name} must select ${column}`).toContain(
          `"opportunity_duplicates"."${column}"`,
        );
      }
    });
  }
});
