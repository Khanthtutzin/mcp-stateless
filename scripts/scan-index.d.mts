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
