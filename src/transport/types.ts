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
