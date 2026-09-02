import type { RunReport } from '../run.js';

/**
 * Machine-readable output.
 *
 * Deliberately flat and stable: the shape here is a public contract, so it
 * drops the `Rule` objects (which carry functions) and keeps only data.
 */
export interface JsonReport {
  schemaVersion: 1;
  tool: { name: string; version: string };
  target: string;
  transport: 'stdio' | 'http';
  targetRevision: string;
  startedAt: string;
  durationMs: number;
  ready: boolean;
  /** Present only when the server never answered; no checks were run. */
  unreachable?: string;
  /**
   * Present when some probes got no answer, so the run is not a verdict. A
   * consumer treating `ready: false` as "has errors" should read this first.
   */
  incomplete?: { probes: number; failed: number; reason: string };
  summary: {
    checks: number;
    errors: number;
    warnings: number;
    crashed: number;
    /** Breaking findings an SDK upgrade resolves, with no change to your code. */
    sdkErrors: number;
    /** Breaking findings that need a change in the server itself. */
    applicationErrors: number;
  };
  findings: Array<{
    ruleId: string;
    severity: 'error' | 'warning';
    remediation: 'sdk' | 'application';
    title: string;
    observed: string;
    expected: string;
    fix: string;
    specRef: string;
  }>;
  crashedRules: Array<{ ruleId: string; error: string }>;
  diagnostics: string[];
}

export function toJsonReport(report: RunReport, version: string): JsonReport {
  const crashed = report.outcomes.filter((o) => o.crashed);
  return {
    schemaVersion: 1,
    tool: { name: 'mcp-stateless', version },
    target: report.target,
    transport: report.transport,
    targetRevision: report.targetRevision,
    startedAt: report.startedAt,
    durationMs: report.durationMs,
    ready: report.ready,
    ...(report.unreachable ? { unreachable: report.unreachable } : {}),
    ...(report.incomplete ? { incomplete: report.incomplete } : {}),
    summary: {
      checks: report.outcomes.length,
      errors: report.errorCount,
      warnings: report.warningCount,
      crashed: crashed.length,
      sdkErrors: report.findings.filter(
        (f) => f.severity === 'error' && f.remediation === 'sdk',
      ).length,
      applicationErrors: report.findings.filter(
        (f) => f.severity === 'error' && f.remediation === 'application',
      ).length,
    },
    findings: report.findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      remediation: f.remediation,
      title: f.title,
      observed: f.observed,
      expected: f.expected,
      fix: f.fix,
      specRef: f.specRef,
    })),
    crashedRules: crashed.map((o) => ({ ruleId: o.rule.id, error: o.crashed! })),
    diagnostics: report.diagnostics,
  };
}

export function renderJson(report: RunReport, version: string): string {
  return JSON.stringify(toJsonReport(report, version), null, 2);
}
