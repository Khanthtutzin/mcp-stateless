#!/usr/bin/env node
/**
 * A server that starts out compliant and then stops.
 *
 * Usage: node dies-after.mjs <answers> <exit|mute>
 *
 * It answers the first `answers` requests exactly as the `modern` fixture does,
 * then either exits or stays alive and ignores everything. Both shapes exist
 * because they fail differently on the wire — a dead child resolves pending
 * requests immediately, a mute one makes them time out — and a run must refuse
 * to certify either.
 *
 * The gap this covers: `runChecks` treats "no answer at all" as unreachable
 * only when *every* probe failed, and rules treat a transport failure as "tells
 * us nothing" and report no finding. So a server that dies partway once came
 * back as zero errors and `ready: true`, having actually been asked about one
 * rule in eighteen.
 */
import { createHandler } from './handlers.mjs';

const answers = Number(process.argv[2]);
const after = process.argv[3] ?? 'exit';

if (!Number.isInteger(answers) || answers < 0) {
  process.stderr.write(`Usage: dies-after.mjs <answers> <exit|mute>\n`);
  process.exit(1);
}
if (!['exit', 'mute'].includes(after)) {
  process.stderr.write(`Unknown behaviour: ${after}\n`);
  process.exit(1);
}

const handle = createHandler('modern');
let answered = 0;

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
      continue;
    }

    if (answered >= answers) {
      // Exit code 7 so a test can tell a deliberate stop from a crash.
      if (after === 'exit') process.exit(7);
      continue;
    }

    const response = handle(request);
    if (response) {
      answered += 1;
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  }
});

process.stdin.on('end', () => process.exit(0));
