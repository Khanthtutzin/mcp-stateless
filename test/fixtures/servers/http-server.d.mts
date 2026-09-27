/** Types for the hand-written HTTP fixture server. */
export type FixtureMode =
  | 'legacy'
  | 'modern'
  | 'strict-params'
  | 'strict-headers'
  | 'dual-era'
  | 'partial-cache'
  | 'tools-only';

export interface HttpFixture {
  url: string;
  close(): Promise<void>;
}

export function startHttpFixture(mode: FixtureMode): Promise<HttpFixture>;
