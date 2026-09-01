/**
 * Every request has a deadline, and the two halves of a request can each hang on their own.
 *
 * These run against REAL loopback servers rather than an injected `fetch`, because the case being
 * proved is the runtime's: a peer that completes the TCP handshake and then says nothing, and one
 * that sends headers and half a body and then stops. A stub cannot produce either.
 */
import http from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient } from "../src/http.js";
import { rejection, testConfig, validDocument } from "./helpers.js";

const TIMEOUT_MS = 300;

interface Peer {
  base: string;
  requests: number;
  close(): Promise<void>;
}

/** A server that never finishes answering. `write` decides how far it gets first. */
async function silentPeer(write?: (res: http.ServerResponse) => void): Promise<Peer> {
  const sockets = new Set<Socket>();
  const peer: Peer = {
    base: "",
    requests: 0,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server = http.createServer((_req, res) => {
    peer.requests += 1;
    write?.(res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  peer.base = `http://127.0.0.1:${address.port}`;
  return peer;
}

function clientFor(peer: Peer): ApiClient {
  return new ApiClient(testConfig({ apiBase: peer.base, timeoutMs: TIMEOUT_MS }));
}

describe("a peer that accepts and never sends headers", () => {
  let peer: Peer;
  beforeAll(async () => {
    peer = await silentPeer();
  });
  afterAll(() => peer.close());

  it("fails a read with a coded timeout, and does not try again", async () => {
    const error = await rejection(clientFor(peer).listOpportunities(new URLSearchParams()));
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain(`${TIMEOUT_MS}ms deadline`);
    expect(error.message).toContain("Nothing was retried");
    expect(peer.requests).toBe(1);
  });

  it("fails a write as an ambiguous outcome that points at the owner listing", async () => {
    const before = peer.requests;
    const error = await rejection(clientFor(peer).submitOpportunity(validDocument()));
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain("may have landed");
    expect(error.message).toContain("/v1/me/opportunities");
    expect(error.message).toContain(`${TIMEOUT_MS}ms deadline`);
    expect(peer.requests).toBe(before + 1);
  });
});

describe("a peer that answers and then stalls mid-body", () => {
  let peer: Peer;
  beforeAll(async () => {
    peer = await silentPeer((res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"items":[');
    });
  });
  afterAll(() => peer.close());

  it("fails the read rather than returning the half it received", async () => {
    const error = await rejection(clientFor(peer).listOpportunities(new URLSearchParams()));
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain(`${TIMEOUT_MS}ms deadline`);
  });

  it("leaves the write ambiguous, because the row may already exist", async () => {
    const error = await rejection(clientFor(peer).submitOpportunity(validDocument()));
    expect(error.code).toBe("exec_failed");
    expect(error.message).toContain("may have landed");
    expect(error.message).toContain("mid-body");
  });
});
