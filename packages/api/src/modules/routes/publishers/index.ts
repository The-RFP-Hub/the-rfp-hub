/**
 * `GET /v1/publishers` — public, unauthenticated, and the one place the verified flag is a fact for
 * consumers rather than an authorization input.
 *
 * No JSON-LD context header: a publisher is not a Standard opportunity. It lives in its own plugin
 * for exactly that reason.
 */
import type { FastifyInstance } from "fastify";
import { PublisherService } from "../../services/publishers/publisher.service.js";
import { handled } from "../../shared/route-helpers.js";

const publisherService = new PublisherService();

export const publishers = async (router: FastifyInstance): Promise<void> => {
  router.get(
    "/",
    {
      prefixTrailingSlash: "no-slash",
      schema: {
        operationId: "listPublishers",
        tags: ["publishers"],
        summary: "Verified publishing organizations",
        description:
          "A row here means writes from that namespace are published without review, so a consumer can weigh an entry's provenance. It is not an endorsement of the programs themselves.",
        response: { 200: { $ref: "PublisherList#" } },
      },
    },
    handled(async () => publisherService.list()),
  );
};
