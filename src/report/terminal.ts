import type { RunReport } from '../run.js';
import type { Finding } from '../rules/types.js';

/**
 * ANSI helpers with a no-colour mode. Hand-rolled rather than pulled in, to
 * keep the package at zero runtime dependencies.
 */
function makePalette(enabled: boolean) {
  const wrap = (code: string) => (s: string) => (enabled ? `[${code}m${s}[0m` : s);
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

export interface TerminalOptions {
  color?: boolean;
  /** Include the JSON-RPC traffic behind each finding. */
  verbose?: boolean;
}

export function renderTerminal(report: RunReport, options: TerminalOptions = {}): string {
  const color = options.color ?? true;
  const c = makePalette(color);
  const lines: string[] = [];

  lines.push('');
  lines.push(
    `${c.bold('mcp-stateless')} ${c.dim(`— checking against MCP ${report.targetRevision}`)}`,
  );
  lines.push(`${c.dim('target:')} ${report.target} ${c.dim(`(${report.transport})`)}`);
  lines.push('');

  if (report.unreachable) {
    lines.push(`${c.red('UNREACHABLE')} — ${report.unreachable}`);
    lines.push('');
    lines.push(c.dim('  No checks were run. Nothing here is a verdict on conformance.'));
    if (report.diagnostics.length) {
      lines.push('');
      lines.push(c.bold('  Transport diagnostics'));
      for (const note of report.diagnostics.slice(0, 10))
        lines.push(c.dim(`    ${note}`));
    }
    lines.push('');
    return lines.join('\n');
  }

  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');

  if (errors.length) {
    lines.push(c.bold(c.red(`Breaking (${errors.length})`)));
    lines.push('');
    for (const f of errors) lines.push(...renderFinding(f, c, options.verbose ?? false));
  }

  if (warnings.length) {
    lines.push(c.bold(c.yellow(`Deprecations and advisories (${warnings.length})`)));
    lines.push('');
    for (const f of warnings)
      lines.push(...renderFinding(f, c, options.verbose ?? false));
  }

  const crashed = report.outcomes.filter((o) => o.crashed);
  if (crashed.length) {
    lines.push(c.bold(c.yellow(`Rules that failed to run (${crashed.length})`)));
    lines.push(
      c.dim('  This is a bug in mcp-stateless. Please report it with the output below.'),
    );
    for (const o of crashed) {
      lines.push(`  ${o.rule.id}: ${o.crashed?.split('\n')[0] ?? 'unknown error'}`);
    }
    lines.push('');
  }

  if (report.diagnostics.length && options.verbose) {
    lines.push(c.bold('Transport diagnostics'));
    for (const note of report.diagnostics.slice(0, 20)) lines.push(c.dim(`  ${note}`));
    lines.push('');
  }

  // Split the verdict by who has to act. Against a stock SDK server almost
  // everything lands on the left of this line, and saying so up front stops a
  // maintainer hunting through code they did not write.
  const sdkErrors = errors.filter((f) => f.remediation === 'sdk').length;
  const appErrors = errors.length - sdkErrors;

  const checked = report.outcomes.length;
  if (report.incomplete) {
    const { failed, probes, reason } = report.incomplete;
    lines.push(
      `${c.red('INCOMPLETE')} — ${failed} of ${probes} probes got no answer, so this is not a verdict.`,
    );
    lines.push(c.dim(`  First failure: ${reason}`));
    lines.push(
      c.dim(
        '  Anything listed above is real, but the checks that went unanswered ' +
          'reported nothing either way. Re-run once the server stays up.',
      ),
    );
  } else if (report.ready) {
    const suffix = warnings.length
      ? ` ${c.dim(`(${warnings.length} advisory item${warnings.length === 1 ? '' : 's'})`)}`
      : '';
    lines.push(
      `${c.green('READY')} — no breaking issues across ${checked} checks.${suffix}`,
    );
  } else {
    lines.push(
      `${c.red('NOT READY')} — ${errors.length} breaking issue${errors.length === 1 ? '' : 's'} ` +
        `across ${checked} checks.`,
    );
    if (sdkErrors) {
      lines.push(
        c.dim(
          `  ${sdkErrors} of those ${sdkErrors === 1 ? 'is' : 'are'} protocol plumbing owned by your MCP SDK — ` +
            'upgrading to a release that targets ' +
            `${report.targetRevision} resolves them with no change to your code.`,
        ),
      );
    }
    lines.push(
      c.dim(
        appErrors
          ? `  ${appErrors} need${appErrors === 1 ? 's' : ''} a change in your server: ` +
              errors
                .filter((f) => f.remediation === 'application')
                .map((f) => f.ruleId)
                .join(', ')
          : '  None require a change to your own code.',
      ),
    );
  }
  lines.push(c.dim(`Finished in ${report.durationMs}ms.`));
  lines.push('');

  return lines.join('\n');
}

function renderFinding(
  f: Finding,
  c: ReturnType<typeof makePalette>,
  verbose: boolean,
): string[] {
  const badge = f.severity === 'error' ? c.red('×') : c.yellow('!');
  const owner = f.remediation === 'sdk' ? c.dim(' (SDK)') : '';
  const out = [
    `  ${badge} ${c.bold(f.ruleId)}  ${f.title}${owner}`,
    `      ${c.dim('found')}     ${f.observed}`,
    `      ${c.dim('expected')}  ${f.expected}`,
    `      ${c.dim('fix')}       ${f.fix}`,
    `      ${c.dim('spec')}      ${c.cyan(f.specRef)}`,
  ];

  if (verbose && f.evidence.length) {
    out.push(`      ${c.dim('traffic')}`);
    for (const ex of f.evidence.slice(0, 2)) {
      out.push(`        ${c.dim('→')} ${truncate(JSON.stringify(ex.request), 160)}`);
      const reply = ex.transportError
        ? `(no response: ${ex.transportError})`
        : truncate(JSON.stringify(ex.response), 160);
      out.push(`        ${c.dim('←')} ${reply}`);
    }
  }

  out.push('');
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
