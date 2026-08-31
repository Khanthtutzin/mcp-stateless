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
  /**
   * Needed to run `npm install` on Windows, where npm is a batch shim that
   * Node refuses to spawn directly.
   */
  planSpawn?: typeof import('../src/transport/spawn-plan.js').planSpawn;
}

export type Probe = (
  target: Target,
  opts?: { timeoutMs?: number; budgetMs?: number },
) => Promise<RunReport>;

/**
 * `install` is injected only by the tests, so the npm path can be exercised
 * without touching the network.
 */
export function createProbe(lib: Lib & { install?: typeof installTarget }): Probe;

/**
 * The absolute path to a package's declared bin, having checked it stays inside
 * the package directory. Throws rather than returning a path to refuse.
 */
export function resolveNpmBin(installDir: string, pkg: string, binName: string): string;

export interface InstallOptions {
  /** Injected by tests so the npm path runs without touching the network. */
  run?: (cmd: string, args: string[], opts: object) => unknown;
  /** Required on Windows, where npm is a batch shim. */
  planSpawn?: typeof import('../src/transport/spawn-plan.js').planSpawn;
}

export function installTarget(
  target: NpmTarget,
  dir: string,
  options?: InstallOptions,
): void;

export function toResult(target: Target, report: RunReport): TargetResult;

export interface ScanOptions {
  probe: Probe;
  /** Per-request timeout, passed through to the transport. */
  timeoutMs?: number;
  /**
   * Wall-clock ceiling per target. A per-request timeout applies once per
   * probe, so a server that accepts a connection and answers nothing costs
   * that timeout about twenty times over.
   */
  budgetMs?: number;
  toolVersion: string;
  rulesetSize: number;
  /** Injected so a snapshot can be given a fixed timestamp in tests. */
  now?: () => Date;
}

export function scanTargets(targets: Target[], opts: ScanOptions): Promise<RunSnapshot>;
