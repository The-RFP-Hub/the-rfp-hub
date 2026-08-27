/**
 * `fetch_opportunity` — one full record, wrapped but not altered.
 *
 * The document goes into an ENVELOPE (`notice`, `opportunity`, `links`) rather than being returned
 * bare, so the labelling has somewhere to live and the two counted redirect URLs can be handed
 * over without inventing fields inside somebody else's document.
 *
 * THE PROMISE IS STRUCTURAL EQUIVALENCE, NOT BYTE EQUIVALENCE. The body is parsed and
 * re-serialized on the way through, so key order and whitespace may differ from the bytes the API
 * sent. What is promised, and what the tests assert: no field removed, no field added, no value
 * changed. Saying "verbatim" would be a promise the transport does not keep.
 *
 * This is the tool that DOES return `description` and `summary` — free prose written by a third
 * party. That is the point of it: a caller who needs the full text asks for it by id, one record
 * at a time, rather than receiving twenty of them as a side effect of a search.
 */
import { z } from "zod";
import { FETCH_NOTICE, delimit } from "../untrusted.js";
import type { ToolContext, ToolSuccess } from "./context.js";

export const TOOL_NAME = "fetch_opportunity";

export const TOOL_DESCRIPTION =
  "Fetch one published funding opportunity in full by its id, as an RFP Hub Standard document: " +
  "title, summary, description, eligibility, organizations, funding amounts, deadlines and the " +
  "funding-type-specific details. Use the id returned by search_opportunities. The document is " +
  "third-party published text.";

export const inputSchema = z.strictObject({
  id: z
    .string()
    .min(3)
    .max(200)
    .describe("The public id, `<namespace>:<local>`, as returned by search_opportunities."),
});

export type FetchInput = z.infer<typeof inputSchema>;

export const outputSchema = z.object({
  notice: z.string(),
  opportunity: z
    .record(z.string(), z.unknown())
    .describe("The RFP Hub Standard document, structurally unmodified."),
  links: z.object({
    apply: z.string().describe("The hub's counted redirect to the application page."),
    source: z.string().describe("The hub's counted redirect to the original listing."),
  }),
});

export type FetchOutput = z.infer<typeof outputSchema>;

export function envelope(
  opportunity: Record<string, unknown>,
  id: string,
  apiBase: string,
): FetchOutput {
  return {
    notice: FETCH_NOTICE,
    opportunity,
    links: {
      apply: `${apiBase}/v1/r/${encodeURIComponent(id)}/apply`,
      source: `${apiBase}/v1/r/${encodeURIComponent(id)}/source`,
    },
  };
}

export function renderText(result: FetchOutput): string {
  return [
    result.notice,
    "",
    delimit("opportunity document (JSON)", JSON.stringify(result.opportunity, null, 2)),
    "",
    `apply:  ${result.links.apply}`,
    `source: ${result.links.source}`,
  ].join("\n");
}

export async function run(input: FetchInput, ctx: ToolContext): Promise<ToolSuccess> {
  const document = (await ctx.api.getOpportunity(input.id)) as unknown as Record<string, unknown>;
  const result = envelope(document, input.id, ctx.config.apiBase);
  return { text: renderText(result), structured: result };
}
