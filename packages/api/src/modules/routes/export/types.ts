/**
 * PURE query-string contract for the download routes — no Fastify/DB deps.
 *
 * The surface is EMPTY, and that is the contract rather than an omission. A download is the whole
 * public dataset; filtering, sorting and paginating it is what `/v1/opportunities` is for, and a
 * parameter accepted here would have to be honoured by the nightly snapshot too or the two would
 * stop being interchangeable — which is the one property these routes exist to have.
 *
 * Empty is not the same as permissive. `additionalProperties: false` is validated by Fastify BEFORE
 * the handler runs and is ENFORCED rather than stripped (buildApp disables ajv's `removeAdditional`),
 * so any query parameter at all is a 400, exactly as on every other route in this API. Someone who
 * writes `?status=open` expecting a filtered download must find that out on the first request,
 * not from a dataset that quietly ignored them — a 400 here is far cheaper than a silent
 * megabyte-scale misunderstanding. If a filter is ever added, it is added deliberately, to both
 * this contract and the published snapshot.
 */
export const noQuerySchema = {
  type: "object",
  properties: {},
  // Enforced, not stripped — see the module comment.
  additionalProperties: false,
} as const;
