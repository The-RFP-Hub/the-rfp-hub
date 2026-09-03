/**
 * The last thing between this process and the wire: every OUTBOUND message is redacted, including
 * the ones the SDK words itself (an argument-validation failure quoting arguments back, an unknown
 * tool name echoed in a JSON-RPC error) — paths this package does not author and cannot route
 * around. Inbound messages pass through untouched: rewriting a request would corrupt a legitimate
 * one, and a credential a caller should not have sent is refused loudly, never reshaped.
 *
 * The three callbacks are ACCESSORS onto the wrapped transport, not fields: the SDK assigns them
 * on the transport it was handed, and the inner instance is what invokes them.
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
