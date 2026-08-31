#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { renderJson } from '../report/json.js';
import { renderMarkdown } from '../report/markdown.js';
import { renderSarif } from '../report/sarif.js';
import { renderTerminal } from '../report/terminal.js';
import { TARGET_REVISION } from '../protocol.js';
import { ALL_RULES, ruleById } from '../rules/index.js';
import { runChecks } from '../run.js';
import { HttpTransport } from '../transport/http.js';
import { StdioTransport } from '../transport/stdio.js';
import type { Transport } from '../transport/types.js';

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_USAGE = 2;

function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `
mcp-stateless — check whether an MCP server is ready for the ${TARGET_REVISION} stateless spec

USAGE
  mcp-stateless --stdio "<command>"      probe a server over stdio
  mcp-stateless --http <url>             probe a server over Streamable HTTP

OPTIONS
  --stdio <command>     Command that starts the server on stdio.
  --http <url>          Streamable HTTP endpoint.
  --header <k:v>        Extra HTTP header. Repeatable.
  --cwd <dir>           Working directory for the --stdio command.

  --format <fmt>        text (default), json, sarif, markdown.
  --output <file>       Write the report to a file instead of stdout.
  --emit <fmt>:<file>   Also write this format to this file. Repeatable, and
                        renders from the same single probe.
  --verbose             Include the JSON-RPC traffic behind each finding.
  --no-color            Disable ANSI colour.

  --only <ids>          Comma-separated rule ids to run exclusively.
  --skip <ids>          Comma-separated rule ids to skip.
  --timeout <ms>        Per-request timeout. Default 10000.
  --fail-on <level>     error (default), warning, or never.

  --list-rules          Print the rule catalogue and exit.
  --version, --help

EXIT CODES
  0  ready              1  findings at or above --fail-on
  2  usage error, unreachable server, or an --emit file that could not be written

EXAMPLES
  mcp-stateless --stdio "node dist/server.js"
  mcp-stateless --http https://api.example.com/mcp --header "Authorization: Bearer $TOKEN"
  mcp-stateless --stdio "npx -y my-server" --format sarif --output mcp-stateless.sarif
`;

function listRules(): string {
  const lines = [`mcp-stateless rule catalogue — MCP ${TARGET_REVISION}`, ''];
  for (const rule of ALL_RULES) {
    const level = rule.severity === 'error' ? 'error  ' : 'warning';
    lines.push(`  ${rule.id}  ${level}  ${rule.title}`);
    lines.push(
      `            ${rule.appliesTo.join(', ').padEnd(12)} ${rule.changelogRef}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function parseHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values) {
    const idx = raw.indexOf(':');
    if (idx === -1)
      throw new Error(`Malformed --header "${raw}". Expected "Name: value".`);
    headers[raw.slice(0, idx).trim().toLowerCase()] = raw.slice(idx + 1).trim();
  }
  return headers;
}

const FORMATS = ['text', 'json', 'sarif', 'markdown'] as const;
type Format = (typeof FORMATS)[number];

interface Emit {
  format: Format;
  path: string;
}

/**
 * Parse `--emit <format>:<file>` pairs.
 *
 * Split on the FIRST colon only, so a Windows path keeps its drive letter:
 * `json:C:\reports\out.json` is a format of `json` and a path of
 * `C:\reports\out.json`.
 */
export function parseEmits(values: string[]): Emit[] {
  return values.map((raw) => {
    const idx = raw.indexOf(':');
    if (idx === -1) {
      throw new Error(
        `Malformed --emit "${raw}". Expected "<format>:<file>", e.g. --emit json:report.json.`,
      );
    }
    const format = raw.slice(0, idx).trim().toLowerCase();
    const path = raw.slice(idx + 1).trim();
    if (!FORMATS.includes(format as Format)) {
      throw new Error(
        `Unknown format "${format}" in --emit "${raw}". Expected one of: ${FORMATS.join(', ')}.`,
      );
    }
    if (!path) {
      throw new Error(`Missing file path in --emit "${raw}".`);
    }
    return { format: format as Format, path };
  });
}

function parseRuleIds(csv: string | undefined, flag: string): string[] | undefined {
  if (!csv) return undefined;
  const ids = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !ruleById(id));
  if (unknown.length) {
    throw new Error(
      `Unknown rule id(s) in ${flag}: ${unknown.join(', ')}. Run --list-rules to see the catalogue.`,
    );
  }
  return ids;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        stdio: { type: 'string' },
        http: { type: 'string' },
        header: { type: 'string', multiple: true, default: [] },
        cwd: { type: 'string' },
        format: { type: 'string', default: 'text' },
        output: { type: 'string' },
        emit: { type: 'string', multiple: true, default: [] },
        verbose: { type: 'boolean', default: false },
        // `node:util.parseArgs` has no notion of `--no-x` negation, so the
        // documented `--no-color` has to be its own option.
        color: { type: 'boolean', default: true },
        'no-color': { type: 'boolean', default: false },
        only: { type: 'string' },
        skip: { type: 'string' },
        timeout: { type: 'string' },
        'fail-on': { type: 'string', default: 'error' },
        'list-rules': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${HELP}`);
    return EXIT_USAGE;
  }

  const opts = parsed.values;

  if (opts.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (opts.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT_OK;
  }
  if (opts['list-rules']) {
    process.stdout.write(listRules());
    return EXIT_OK;
  }

  if (!opts.stdio && !opts.http) {
    process.stderr.write(`Specify a target with --stdio or --http.\n${HELP}`);
    return EXIT_USAGE;
  }
  if (opts.stdio && opts.http) {
    process.stderr.write('Specify only one of --stdio or --http.\n');
    return EXIT_USAGE;
  }

  const format = String(opts.format);
  if (!['text', 'json', 'sarif', 'markdown'].includes(format)) {
    process.stderr.write(`Unknown --format "${format}".\n`);
    return EXIT_USAGE;
  }

  const failOn = String(opts['fail-on']);
  if (!['error', 'warning', 'never'].includes(failOn)) {
    process.stderr.write(`Unknown --fail-on "${failOn}".\n`);
    return EXIT_USAGE;
  }

  let only: string[] | undefined;
  let skip: string[] | undefined;
  let headers: Record<string, string>;
  let emits: Emit[];
  try {
    only = parseRuleIds(opts.only, '--only');
    skip = parseRuleIds(opts.skip, '--skip');
    headers = parseHeaders(opts.header as string[]);
    // Validated before anything is probed: a typo in a CI config should fail
    // instantly, not after spawning someone's server.
    emits = parseEmits(opts.emit as string[]);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_USAGE;
  }

  let timeoutMs: number | undefined;
  if (opts.timeout !== undefined) {
    timeoutMs = Number(opts.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      process.stderr.write(`--timeout must be a positive number of milliseconds.\n`);
      return EXIT_USAGE;
    }
  }

  const transport: Transport = opts.stdio
    ? new StdioTransport(opts.stdio, opts.cwd)
    : new HttpTransport(opts.http!, headers);

  try {
    const report = await runChecks(transport, { only, skip, timeoutMs });
    const version = packageVersion();

    /**
     * Render one format from the report already in hand. Every rendering — the
     * one on stdout and every `--emit` file — comes from this single
     * `RunReport`, so they cannot describe different probes.
     */
    const render = (fmt: Format, color: boolean): string => {
      switch (fmt) {
        case 'json':
          return renderJson(report, version);
        case 'sarif':
          return renderSarif(report, version);
        case 'markdown':
          return renderMarkdown(report);
        default:
          return renderTerminal(report, { color, verbose: opts.verbose });
      }
    };

    const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

    const output = render(
      format as Format,
      // Honour --no-color and the NO_COLOR convention, and never emit escapes
      // when stdout is redirected to a file or a pipe.
      !opts['no-color'] &&
        opts.color !== false &&
        !process.env['NO_COLOR'] &&
        process.stdout.isTTY === true,
    );

    if (opts.output) {
      writeFileSync(opts.output, output.endsWith('\n') ? output : `${output}\n`, 'utf8');
      process.stdout.write(`Report written to ${opts.output}\n`);
    } else {
      process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    }

    // Emitted after the report has been delivered, so a bad path in a CI config
    // costs the artefact but never the diagnostic output the user came for.
    // A file never gets ANSI escapes, whatever the terminal supports.
    let emitFailed = false;
    for (const emit of emits) {
      try {
        writeFileSync(emit.path, withNewline(render(emit.format, false)), 'utf8');
      } catch (err) {
        emitFailed = true;
        process.stderr.write(
          `Could not write --emit ${emit.format}:${emit.path} — ${(err as Error).message}\n`,
        );
      }
    }

    // A server we could not reach is an operational failure, not a conformance
    // verdict, so it gets the usage exit code rather than the findings one.
    if (report.unreachable) return EXIT_USAGE;
    // A probe that lost some of its answers is not a verdict either, whatever
    // --fail-on says: an empty findings list from a server that stopped talking
    // would otherwise exit 0 under a report that reads INCOMPLETE.
    if (report.incomplete) return EXIT_USAGE;
    // Same reasoning for an artefact a CI job asked for and did not get.
    if (emitFailed) return EXIT_USAGE;
    if (failOn === 'never') return EXIT_OK;
    if (failOn === 'warning') {
      return report.errorCount + report.warningCount > 0 ? EXIT_FINDINGS : EXIT_OK;
    }
    return report.errorCount > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (err) {
    process.stderr.write(`mcp-stateless failed: ${(err as Error).message}\n`);
    return EXIT_USAGE;
  } finally {
    await transport.close();
  }
}

/**
 * True when this file was invoked directly rather than imported. Compared via
 * realpath so that npm's bin symlinks and Windows path casing both resolve.
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`mcp-stateless crashed: ${(err as Error).stack ?? err}\n`);
      process.exitCode = EXIT_USAGE;
    },
  );
}
