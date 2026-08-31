/**
 * Types for scripts/aggregate-index.mjs.
 *
 * Hand-written, following the convention already used by
 * test/fixtures/servers/http-server.d.mts: the script stays plain JavaScript so
 * it never ships inside the published package, while TS tests still get real
 * types.
 */

export interface TargetResult {
  id: string;
  package: string;
  version: string;
  transport: 'stdio' | 'http';
  ready: boolean;
  errorCount: number;
  warningCount: number;
  sdkErrors: number;
  applicationErrors: number;
  failedRules: string[];
  /** A reason string when the target could not be measured, else null. */
  unreachable: string | null;
}

export interface RunSnapshot {
  schemaVersion: 1;
  scannedAt: string;
  toolVersion: string;
  rulesetSize: number;
  results: TargetResult[];
}

export interface HistoryRow {
  date: string;
  toolVersion: string;
  rulesetSize: number;
  cohortSize: number;
  measured: number;
  unreachable: number;
  ready: number;
  /** Null when nothing was measurable. */
  medianErrors: number | null;
  sdkErrors: number;
  applicationErrors: number;
  ruleFailureCounts: Record<string, number>;
}

export function parseRunSnapshot(text: string): RunSnapshot;
export function summarise(snapshot: RunSnapshot): HistoryRow;
