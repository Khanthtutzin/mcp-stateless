/**
 * The transport boundary.
 *
 * Rules never see this module. They talk to a `ProbeContext`, which owns a
 * `Transport`. That separation is what lets a contributor add a rule without
 * knowing anything about child processes or SSE framing.
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: JsonRpcError;
}

/**
 * One request/response round trip, recorded in full.
 *
 * Findings quote these verbatim, so a maintainer reading a report can see the
 * exact wire traffic that produced it rather than taking our word for it.
 */
export interface Exchange {
  request: JsonRpcRequest;
  requestHeaders: Record<string, string>;
  response: JsonRpcResponse | null;
  responseHeaders: Record<string, string>;
  /** HTTP status, when the transport has one. */
  status?: number;
  timingMs: number;
  /**
   * Set when no valid JSON-RPC response came back at all: timeout, crash,
   * connection refused, unparseable output. Distinct from a JSON-RPC error,
   * which is a *successful* exchange carrying an error payload.
   */
  transportError?: string;
  /**
   * Set when the request was answered by an acknowledgement notification
   * rather than a response — see `SendOptions.acknowledgedBy`. `response` is
   * then null, and the exchange is answered, not lost.
   */
  acknowledgement?: JsonRpcNotification;
}

/** A JSON-RPC message with no id, such as a server notification. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/** The `_meta` key a 2026-07-28 server tags subscription traffic with. */
export const SUBSCRIPTION_ID_META = 'io.modelcontextprotocol/subscriptionId';

/**
 * True when `message` is the notification `method`, tagged with `id` as its
 * subscription id — how a long-lived request such as `subscriptions/listen`
 * says it was accepted without ever sending a response.
 */
export function acknowledges(
  message: unknown,
  method: string,
  id: string | number,
): boolean {
  if (message === null || typeof message !== 'object') return false;
  const m = message as { method?: unknown; params?: { _meta?: Record<string, unknown> } };
  return m.method === method && m.params?._meta?.[SUBSCRIPTION_ID_META] === id;
}

export interface SendOptions {
  /** Extra or overriding HTTP headers. Ignored by the stdio transport. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Skip the standard `Mcp-Method` / `Mcp-Name` headers. Used by the rule that
   * checks whether a server tolerates their absence.
   */
  omitStandardHeaders?: boolean;
  /** Send as a notification: no id, no response expected. */
  notification?: boolean;
  /**
   * A notification method that answers this request as well as a response
   * would. `subscriptions/listen` is held open for the life of the stream, so
   * a working server sends `notifications/subscriptions/acknowledged` tagged
   * with the request's id and never a response. Without this, the probe of a
   * compliant server would time out and be counted as unanswered.
   */
  acknowledgedBy?: string;
}

/** A raw non-JSON-RPC HTTP probe, used to detect leftover GET endpoints. */
export interface RawHttpResult {
  status: number;
  headers: Record<string, string>;
  bodyPreview: string;
  error?: string;
}

/** A GET for a public JSON metadata document, such as OAuth discovery. */
export interface MetadataFetch {
  url: string;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  /** The parsed body, when it was JSON. */
  json?: unknown;
  error?: string;
}

export interface Transport {
  readonly kind: 'stdio' | 'http';
  /** Human-readable description of the target, for report headers. */
  readonly target: string;

  send(request: JsonRpcRequest, options?: SendOptions): Promise<Exchange>;

  /**
   * Issue a bare HTTP request that is not JSON-RPC. Only meaningful for the
   * HTTP transport; stdio returns `null`.
   */
  rawRequest?(method: string, headers?: Record<string, string>): Promise<RawHttpResult>;

  /**
   * GET a public JSON document at an absolute http(s) URL, which may be on
   * another origin. Never sends the user's extra headers: those usually carry
   * a bearer token, and discovery metadata is public by definition, so
   * forwarding them would hand a credential to whatever host the server's
   * metadata names. Only meaningful for the HTTP transport.
   */
  fetchMetadata?(url: string): Promise<MetadataFetch>;

  /** Anything the transport captured out of band (e.g. stderr from a child). */
  diagnostics(): string[];

  close(): Promise<void>;
}
