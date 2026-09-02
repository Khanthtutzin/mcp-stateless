import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { renderJson } from '../src/report/json.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderTerminal } from '../src/report/terminal.js';
import { runChecks } from '../src/run.js';
import { StdioTransport } from '../src/transport/stdio.js';

const DIES_AFTER = fileURLToPath(
  new URL('./fixtures/servers/dies-after.mjs', import.meta.url),
);

async function run(answers: number, after: 'exit' | 'mute', timeoutMs = 300) {
  const transport = new StdioTransport(`node "${DIES_AFTER}" ${answers} ${after}`);
  try {
    return await runChecks(transport, { timeoutMs });
  } finally {
    await transport.close();
  }
}

/**
 * A server that answers some probes and then stops.
 *
 * `unreachable` only covers the all-or-nothing case, and every rule treats a
 * transport failure as "tells us nothing" and returns no finding. Without a
 * third state, a server that died after one reply reports zero errors — a green
 * verdict drawn from one rule out of eighteen.
 */
describe('a run that could not be completed', () => {
  it('is never reported as ready, however few probes were lost', async () => {
    for (const answers of [1, 2, 3, 5]) {
      const report = await run(answers, 'exit');
      expect(report.ready, `after ${answers} answers`).toBe(false);
      expect(report.incomplete, `after ${answers} answers`).toBeDefined();
    }
  });

  it('is not ready when the server goes mute instead of exiting', async () => {
    const report = await run(1, 'mute', 200);
    expect(report.ready).toBe(false);
    expect(report.incomplete).toBeDefined();
  });

  it('says how much of the probe was lost, and why', async () => {
    const report = await run(2, 'exit');
    const incomplete = report.incomplete!;
    expect(incomplete.failed).toBeGreaterThan(0);
    expect(incomplete.probes).toBeGreaterThan(incomplete.failed);
    expect(incomplete.reason).toMatch(/exited|no longer running|No response/i);
  });

  it('is distinct from unreachable, which means nothing answered at all', async () => {
    const report = await run(0, 'exit');
    expect(report.unreachable).toBeTruthy();
    expect(report.incomplete).toBeUndefined();
  });

  it('leaves a fully answered run untouched', async () => {
    // The guard must not fire on an ordinary compliant server, or every row in
    // the index becomes unmeasurable and the whole exercise reports nothing.
    const report = await run(1000, 'exit');
    expect(report.incomplete).toBeUndefined();
    expect(report.ready).toBe(true);
    expect(report.errorCount).toBe(0);
  });

  it('is visible in every report format, not just inferable', async () => {
    const report = await run(2, 'exit');

    expect(renderTerminal(report, { color: false })).toMatch(/INCOMPLETE/);
    expect(renderMarkdown(report)).toMatch(/[Ii]ncomplete/);

    const json = JSON.parse(renderJson(report, '0.0.0-test')) as {
      ready: boolean;
      incomplete?: { probes: number; failed: number; reason: string };
    };
    expect(json.ready).toBe(false);
    expect(json.incomplete?.failed).toBeGreaterThan(0);
  });
});
