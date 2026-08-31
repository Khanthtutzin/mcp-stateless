import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runChecks } from '../src/run.js';
import { StdioTransport } from '../src/transport/stdio.js';

const MUTE = fileURLToPath(new URL('./fixtures/servers/dies-after.mjs', import.meta.url));

/**
 * Closing a transport while a run is still in flight.
 *
 * A caller that gives up on a slow server — a timeout, a per-target budget, a
 * user pressing Ctrl-C — closes the transport, which ends the child's stdin.
 * The abandoned run keeps going and sends its next probe, and a write to an
 * ended stream fails **asynchronously**: the try/catch around it never sees the
 * error, and with no listener on the stream it surfaces as an uncaught
 * exception that takes the process down.
 *
 * Found by the compliance index's per-target budget, which does exactly this.
 */
describe('closing a transport during a run', () => {
  it('does not raise an uncaught error from a late write', async () => {
    const transport = new StdioTransport(`node "${MUTE}" 1 mute`);

    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      const run = runChecks(transport, { timeoutMs: 150 });
      // Close while the run is still issuing probes.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await transport.close();
      await run;
      // Let any asynchronous stream error land before we judge.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(uncaught.map((e) => e.message)).toEqual([]);
  });

  it('reports a send after close as a transport error, not a throw', async () => {
    const transport = new StdioTransport(`node "${MUTE}" 1 mute`);
    await transport.send(
      { jsonrpc: '2.0', method: 'server/discover' },
      { timeoutMs: 150 },
    );
    await transport.close();

    const after = await transport.send(
      { jsonrpc: '2.0', method: 'tools/list' },
      { timeoutMs: 150 },
    );

    expect(after.transportError).toBeTruthy();
    expect(after.response).toBeNull();
  });
});
