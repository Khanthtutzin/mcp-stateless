/**
 * Types for scripts/scan-index.mjs.
 *
 * Hand-written, like scripts/aggregate-index.d.mts, so the script itself stays
 * plain JavaScript and never ships inside the published package. Nothing
 * machine-checks this declaration against the implementation — `loadTargets` is
 * what enforces these shapes at runtime, and it validates against an allow-list.
 */

export interface NpmTarget {
  kind: 'npm';
  id: string;
  label: string;
  package: string;
  /** Exact version. Ranges and dist-tags are refused. */
  version: string;
  /** A bin name as the package declares it, never a path. */
  bin: string;
  transport: 'stdio';
  note?: string;
}

/**
 * A command spawned as given, with nothing installed. Used only by the test
 * suite: the published cohort must never contain one, so `loadTargets` refuses
 * it unless explicitly allowed.
 */
export interface LocalTarget {
  kind: 'local';
  id: string;
  label: string;
  command: string;
  note?: string;
}

export type Target = NpmTarget | LocalTarget;

export function loadTargets(text: string, options?: { allowLocal?: boolean }): Target[];

import type { RunReport } from '../src/run.js';

import type { RunSnapshot, TargetResult } from './aggregate-index.d.mts';

/** The slice of the library a probe needs. */
export interface Lib {
  runChecks: typeof import('../src/run.js').runChecks;
  StdioTransport: typeof import('../src/transport/stdio.js').StdioTransport;
  /**
   * Used to reject a malformed command before the transport turns it into
   * something that looks like the server's fault.
   */
  tokenizeCommand: typeof import('../src/transport/stdio.js').tokenizeCommand;
}

export type Probe = (target: Target, opts?: { timeoutMs?: number }) => Promise<RunReport>;

export function createProbe(lib: Lib): Probe;

export function toResult(target: Target, report: RunReport): TargetResult;

export interface ScanOptions {
  probe: Probe;
  timeoutMs?: number;
  toolVersion: string;
  rulesetSize: number;
  /** Injected so a snapshot can be given a fixed timestamp in tests. */
  now?: () => Date;
}

export function scanTargets(targets: Target[], opts: ScanOptions): Promise<RunSnapshot>;
