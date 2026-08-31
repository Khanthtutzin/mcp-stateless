import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli/index.js';

const STDIO_SERVER = fileURLToPath(
  new URL('./fixtures/servers/stdio-server.mjs', import.meta.url),
);

/** The fixture path may contain spaces, so it is always quoted. */
function target(mode: 'legacy' | 'modern'): string {
  return `node "${STDIO_SERVER}" ${mode}`;
}

let workdir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'mcp-stateless-cli-'));
  stdout = '';
  stderr = '';
  // main() writes to the real streams. Capturing keeps test output pristine
  // and lets us assert on what a user would actually see.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workdir, { recursive: true, force: true });
});

describe('--emit', () => {
  it('writes a rendered format to a file while text still goes to stdout', async () => {
    const jsonPath = join(workdir, 'report.json');

    const code = await main([
      '--stdio',
      target('legacy'),
      '--timeout',
      '5000',
      '--emit',
      `json:${jsonPath}`,
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain('NOT READY');

    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.errors).toBeGreaterThan(0);
  });

  it('renders every requested format from a single probe', async () => {
    const jsonPath = join(workdir, 'report.json');
    const sarifPath = join(workdir, 'report.sarif');
    const mdPath = join(workdir, 'report.md');

    const code = await main([
      '--stdio',
      target('legacy'),
      '--timeout',
      '5000',
      '--emit',
      `json:${jsonPath}`,
      '--emit',
      `sarif:${sarifPath}`,
      '--emit',
      `markdown:${mdPath}`,
    ]);

    expect(code).toBe(1);

    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
    const markdown = readFileSync(mdPath, 'utf8');

    // Every rendering describes the same run, which is the whole point:
    // the JSON that feeds CI outputs cannot disagree with what a human reads.
    expect(sarif.runs[0].results).toHaveLength(
      report.summary.errors + report.summary.warnings,
    );
    for (const finding of report.findings) {
      expect(markdown).toContain(finding.ruleId);
    }
  });

  it('probes once no matter how many formats are requested', async () => {
    const first = join(workdir, 'a.json');
    const second = join(workdir, 'b.json');

    await main([
      '--stdio',
      target('legacy'),
      '--timeout',
      '5000',
      '--emit',
      `json:${first}`,
      '--emit',
      `json:${second}`,
    ]);

    // Identical startedAt AND durationMs can only come from one probe rendered
    // twice. Two probes would differ in at least one of them.
    const a = JSON.parse(readFileSync(first, 'utf8'));
    const b = JSON.parse(readFileSync(second, 'utf8'));
    expect(a.startedAt).toBe(b.startedAt);
    expect(a.durationMs).toBe(b.durationMs);
  });

  it('never writes ANSI escapes into an emitted text file', async () => {
    const textPath = join(workdir, 'report.txt');

    await main([
      '--stdio',
      target('legacy'),
      '--timeout',
      '5000',
      '--emit',
      `text:${textPath}`,
    ]);

    const text = readFileSync(textPath, 'utf8');
    expect(text).toContain('NOT READY');
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\[/);
  });

  it('still prints the report when an --emit path cannot be written', async () => {
    // A path typo in CI must not cost the user the diagnostic output.
    const unwritable = join(workdir, 'no-such-dir', 'deeper', 'report.json');

    const code = await main([
      '--stdio',
      target('legacy'),
      '--timeout',
      '5000',
      '--emit',
      `json:${unwritable}`,
    ]);

    expect(stdout).toContain('NOT READY');
    expect(stderr).toContain('--emit');
    expect(code).toBe(2);
  });

  it('rejects a malformed --emit without probing anything', async () => {
    const code = await main(['--stdio', target('legacy'), '--emit', 'report.json']);

    expect(code).toBe(2);
    expect(stderr).toContain('--emit');
    expect(readdirSync(workdir)).toEqual([]);
  });

  it('rejects an unknown --emit format', async () => {
    const code = await main([
      '--stdio',
      target('legacy'),
      '--emit',
      `yaml:${join(workdir, 'report.yaml')}`,
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain('yaml');
    expect(readdirSync(workdir)).toEqual([]);
  });

  it('rejects an --emit with an empty path', async () => {
    const code = await main(['--stdio', target('legacy'), '--emit', 'json:']);

    expect(code).toBe(2);
    expect(stderr).toContain('--emit');
  });
});

describe('exit codes and usage', () => {
  it('reports a compliant server as ready', async () => {
    const code = await main(['--stdio', target('modern'), '--timeout', '5000']);
    expect(code).toBe(0);
    expect(stdout).toContain('READY');
  });

  it('exits 2 when no target is given', async () => {
    const code = await main([]);
    expect(code).toBe(2);
    expect(stderr).toContain('--stdio');
  });

  it('exits 2 when both transports are given', async () => {
    const code = await main(['--stdio', target('modern'), '--http', 'http://x/mcp']);
    expect(code).toBe(2);
  });

  it('exits 2 on an unknown rule id in --only', async () => {
    const code = await main(['--stdio', target('modern'), '--only', 'MCP999']);
    expect(code).toBe(2);
    expect(stderr).toContain('MCP999');
  });

  it('honours --fail-on never', async () => {
    const code = await main([
      '--stdio',
      target('legacy'),
      '--timeout',
      '5000',
      '--fail-on',
      'never',
    ]);
    expect(code).toBe(0);
  });

  it('lists the rule catalogue without a target', async () => {
    const code = await main(['--list-rules']);
    expect(code).toBe(0);
    expect(stdout).toContain('MCP001');
    expect(stdout).toContain('MCP018');
  });
});
