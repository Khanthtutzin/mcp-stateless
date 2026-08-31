import type { RunReport } from '../run.js';

/**
 * Markdown suitable for a GitHub step summary or a PR comment.
 */
export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  const errors = report.findings.filter((f) => f.severity === 'error');
  const warnings = report.findings.filter((f) => f.severity === 'warning');

  lines.push(`## mcp-stateless — MCP ${report.targetRevision} readiness`);
  lines.push('');

  if (report.unreachable) {
    lines.push(`**Unreachable.** ${report.unreachable}`);
    lines.push('');
    lines.push('No checks were run, so this is not a verdict on conformance.');
    lines.push('');
    lines.push(`\`${report.target}\` · ${report.transport}`);
    lines.push('');
    return lines.join('\n');
  }

  if (report.incomplete) {
    const { failed, probes, reason } = report.incomplete;
    lines.push(
      `**Incomplete.** ${failed} of ${probes} probes got no answer, so this is not a verdict.`,
    );
    lines.push('');
    lines.push(`First failure: ${reason}`);
  } else {
    lines.push(
      report.ready
        ? `**Ready.** No breaking issues across ${report.outcomes.length} checks.`
        : `**Not ready.** ${errors.length} breaking issue${errors.length === 1 ? '' : 's'} across ${report.outcomes.length} checks.`,
    );
  }
  lines.push('');
  lines.push(`\`${report.target}\` · ${report.transport} · ${report.durationMs}ms`);
  lines.push('');

  if (errors.length) {
    const sdk = errors.filter((f) => f.remediation === 'sdk').length;
    const app = errors.length - sdk;
    lines.push('### Breaking');
    lines.push('');
    if (sdk) {
      lines.push(
        `${sdk} of these ${sdk === 1 ? 'is' : 'are'} protocol plumbing owned by your MCP SDK — ` +
          `upgrading to a release targeting ${report.targetRevision} resolves ` +
          `${sdk === 1 ? 'it' : 'them'} with no change to your code. ` +
          `${app === 0 ? 'None require' : `${app} require${app === 1 ? 's' : ''}`} ` +
          'a change in the server itself.',
      );
      lines.push('');
    }
    lines.push(...table(errors));
  }

  if (warnings.length) {
    lines.push('### Deprecations and advisories');
    lines.push('');
    lines.push(...table(warnings));
  }

  if (errors.length || warnings.length) {
    lines.push('<details><summary>How to fix</summary>');
    lines.push('');
    for (const f of [...errors, ...warnings]) {
      lines.push(`**${f.ruleId} — ${f.title}**`);
      lines.push('');
      lines.push(`- Found: ${f.observed}`);
      lines.push(`- Expected: ${f.expected}`);
      lines.push(`- Fix: ${f.fix}`);
      lines.push(`- Spec: ${f.specRef}`);
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  return lines.join('\n');
}

function table(findings: RunReport['findings']): string[] {
  const rows = ['| Rule | Issue | Fixed by |', '| --- | --- | --- |'];
  for (const f of findings) {
    const owner = f.remediation === 'sdk' ? 'SDK upgrade' : 'your code';
    rows.push(`| [${f.ruleId}](${f.specRef}) | ${escapePipes(f.title)} | ${owner} |`);
  }
  rows.push('');
  return rows;
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}
