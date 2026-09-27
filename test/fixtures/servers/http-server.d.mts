/** Types for the hand-written HTTP fixture server. */
export type FixtureMode =
  | 'legacy'
  | 'modern'
  | 'strict-params'
  | 'strict-headers'
  | 'dual-era'
  | 'partial-cache'
  | 'tools-only'
  | 'oauth-no-iss'
  | 'oauth-iss'
  | 'oauth-challenge';

export interface HttpFixture {
  url: string;
  /** Every GET the fixture received off the MCP endpoint, in order. */
  metadataRequests: Array<{ path: string; headers: Record<string, unknown> }>;
  close(): Promise<void>;
}

export function startHttpFixture(mode: FixtureMode): Promise<HttpFixture>;
