#!/usr/bin/env node
/**
 * Fixture MCP server on stdio.
 *
 * Usage: node stdio-server.mjs <legacy|modern|strict-params|dual-era|partial-cache|tools-only|core-tasks|core-and-ext|tasks-ext|hidden-tasks>
 */
import { createHandler } from './handlers.mjs';

const mode = process.argv[2] ?? 'modern';
const MODES = [
  'legacy',
  'modern',
  'strict-params',
  'dual-era',
  'partial-cache',
  'tools-only',
  'core-tasks',
  'core-and-ext',
  'tasks-ext',
  'hidden-tasks',
];
if (!MODES.includes(mode)) {
  process.stderr.write(`Unknown mode: ${mode}\n`);
  process.exit(1);
}

const handle = createHandler(mode);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n',
      );
      continue;
    }

    const response = handle(request);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
});

process.stdin.on('end', () => process.exit(0));
