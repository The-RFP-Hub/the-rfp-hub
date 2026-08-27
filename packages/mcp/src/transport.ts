/**
 * The last thing between this process and the wire.
 *
 * Redacting inside the tool handlers covers what the handlers produce. It does NOT cover what the
 * SDK produces on its own: an argument-validation failure is raised by the SDK's dispatch before
 * any handler runs and quotes the offending arguments back, and an unknown tool name is echoed in
 * a JSON-RPC error. Both are paths this package does not author, and both can carry text a caller
 * supplied — including, if somebody is careless, a credential.
 *
 * So the redaction is also applied where it cannot be routed around: every outbound message,
 * whatever produced it. This is a decorator over a real `Transport`, which is a supported extension
 * point — `serveStdio` accepts one and drives it exactly as it drives its own.
 *
 * INBOUND MESSAGES PASS THROUGH UNTOUCHED. Rewriting a request would corrupt a legitimate one, and
 * a credential a caller should not have sent is a thing to refuse loudly, not to quietly reshape
 * into something that looks fine.
 *
 * The three callbacks are ACCESSORS onto the wrapped transport rather than fields: the SDK assigns
 * them on the transport it was handed, and the wrapped instance is the one that will actually
 * invoke them. Storing them here would leave the inner transport with no handlers at all.
 */
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { redact } from "./redact.js";

export class RedactingTransport implements Transport {
  private readonly inner: Transport;

  constructor(inner: Transport) {
    this.inner = inner;
  }

  get onclose(): Transport["onclose"] {
    return this.inner.onclose;
  }
  set onclose(fn: Transport["onclose"]) {
    this.inner.onclose = fn;
  }

  get onerror(): Transport["onerror"] {
    return this.inner.onerror;
  }
  set onerror(fn: Transport["onerror"]) {
    this.inner.onerror = fn;
  }

  get onmessage(): Transport["onmessage"] {
    return this.inner.onmessage;
  }
  set onmessage(fn: Transport["onmessage"]) {
    this.inner.onmessage = fn;
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.inner.hasPerRequestStream;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  send(message: JSONRPCMessage, options?: Parameters<Transport["send"]>[1]): Promise<void> {
    return this.inner.send(redact(message), options);
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.inner.setSupportedProtocolVersions?.(versions);
  }
}
