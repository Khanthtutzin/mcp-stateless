import { fileURLToPath } from 'node:url';
import { runChecks, type RunReport } from '../src/run.js';
import { StdioTransport } from '../src/transport/stdio.js';
import { HttpTransport } from '../src/transport/http.js';
import type { RunOptions } from '../src/run.js';
import type { FixtureMode } from './fixtures/servers/http-server.mjs';

const STDIO_SERVER = fileURLToPath(
  new URL('./fixtures/servers/stdio-server.mjs', import.meta.url),
);

export type { FixtureMode };

/** Modes only the HTTP fixture can serve: headers and OAuth metadata. */
type HttpOnlyMode = 'strict-headers' | `oauth-${string}`;

/**
 * Run the checker against a fixture server over real stdio.
 *
 * The path is quoted because the repository may live under a directory with
 * spaces — which incidentally exercises the command tokenizer on every run.
 */
export async function checkStdio(
  mode: Exclude<FixtureMode, HttpOnlyMode>,
  options: RunOptions = {},
): Promise<RunReport> {
  const transport = new StdioTransport(`node "${STDIO_SERVER}" ${mode}`);
  try {
    return await runChecks(transport, { timeoutMs: 5000, ...options });
  } finally {
    await transport.close();
  }
}

export async function checkHttp(
  mode: FixtureMode,
  options: RunOptions = {},
): Promise<RunReport> {
  const { startHttpFixture } = await import('./fixtures/servers/http-server.mjs');
  const fixture = await startHttpFixture(mode);
  const transport = new HttpTransport(fixture.url);
  try {
    return await runChecks(transport, { timeoutMs: 5000, ...options });
  } finally {
    await transport.close();
    await fixture.close();
  }
}

/** Distinct rule ids that produced a finding, sorted. */
export function ruleIds(report: RunReport, severity?: 'error' | 'warning'): string[] {
  const findings = severity
    ? report.findings.filter((f) => f.severity === severity)
    : report.findings;
  return [...new Set(findings.map((f) => f.ruleId))].sort();
}

/** Rules that threw. Always expected to be empty. */
export function crashedRules(report: RunReport): string[] {
  return report.outcomes
    .filter((o) => o.crashed)
    .map((o) => `${o.rule.id}: ${o.crashed}`);
}
