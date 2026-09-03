/**
 * `fetch_opportunity` — one full record in an envelope (`notice`, `opportunity`, `links`), so the
 * labeling has somewhere to live and the counted redirect URLs need not be invented inside
 * somebody else's document.
 *
 * THE PROMISE IS STRUCTURAL EQUIVALENCE, NOT BYTE EQUIVALENCE: the body is parsed and
 * re-serialized, so key order and whitespace may differ. No field removed, added or changed.
 *
 * This is the tool that DOES return `description` and `summary` — asked for by id, one record at a
 * time, rather than arriving as a side effect of a search.
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
