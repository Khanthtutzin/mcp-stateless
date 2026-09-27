import { isMethodNotFound, succeeded, type ProbeContext } from '../probe/context.js';
import { specUrl } from '../protocol.js';
import { checkRemovedMethod } from './helpers.js';
import { describe, finding, type Finding, type Rule } from './types.js';

const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** A task id no real server issued, used to reach the handler without a task. */
const NONEXISTENT_TASK = 'mcp-stateless-probe-no-such-task-7c1e';

const REMOVED_FIX = `Delete the tasks/list and tasks/result handlers. Tasks now live in the ${TASKS_EXTENSION} extension: clients poll tasks/get instead of blocking on tasks/result, and there is no task listing.`;

const ADVERTISE_FIX = `Advertise the extension in server/discover as capabilities.extensions["${TASKS_EXTENSION}"]: {}, and serve tasks through it. With the TypeScript SDK that is the @modelcontextprotocol/ext-tasks package.`;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * SEP-2663 moved tasks out of the core protocol into the official
 * `io.modelcontextprotocol/tasks` extension, and redesigned them on the way:
 * polling through `tasks/get` replaced the blocking `tasks/result`, and
 * `tasks/list` was removed. A client now learns that a server supports tasks
 * only from the extension entry in `server/discover` — the core `tasks`
 * capability means nothing to it.
 *
 * What the reference implementation does, which is what these checks are
 * calibrated against: the 2026-07-28 TypeScript SDK serves no core task
 * methods and strips a core `tasks` capability before answering a 2026 client,
 * and the ext-tasks client recognises support only from the extension entry.
 * Capabilities are read from `server/discover` alone. The legacy `initialize`
 * result is a 2025-11-25 answer, where a core `tasks` key is correct, so a
 * dual-era server is not faulted for it.
 */
export const MCP021: Rule = {
  id: 'MCP021',
  title: 'Tasks are still served from the core protocol, not the tasks extension',
  remediation: 'sdk',
  severity: 'error',
  specRef: specUrl('basic/utilities/tasks'),
  changelogRef: 'Major change 6 (SEP-2663)',
  appliesTo: ['stdio', 'http'],

  async run(ctx: ProbeContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    // 1. The two methods the redesign removed. Asked with a 2026 envelope, so
    //    a dual-era server that keeps them for older clients answers -32601.
    findings.push(
      ...(await checkRemovedMethod(this, ctx, 'tasks/list', {}, REMOVED_FIX)),
    );
    findings.push(
      ...(await checkRemovedMethod(
        this,
        ctx,
        'tasks/result',
        { taskId: NONEXISTENT_TASK },
        REMOVED_FIX,
      )),
    );

    // Everything below is about what the server advertises, which a server
    // without a working server/discover has nowhere to say. MCP001 owns that.
    const { discover } = ctx.prelude;
    if (!succeeded(discover)) return findings;
    const capabilities = discover.response?.result?.capabilities;
    if (!isPlainObject(capabilities)) return findings;

    const extensions = capabilities['extensions'];
    const advertised =
      isPlainObject(extensions) && isPlainObject(extensions[TASKS_EXTENSION]);
    const coreTasks = 'tasks' in capabilities;

    // 2. Tasks declared the 2025-11-25 way.
    if (coreTasks) {
      findings.push(
        finding(this, {
          title: advertised
            ? 'server/discover still carries the removed core tasks capability'
            : 'Tasks are declared in core capabilities, where 2026-07-28 clients do not look',
          severity: advertised ? 'warning' : 'error',
          observed: advertised
            ? `server/discover advertises the ${TASKS_EXTENSION} extension and also a core capabilities.tasks entry.`
            : `server/discover declares capabilities.tasks and does not advertise the ${TASKS_EXTENSION} extension.`,
          expected: `Tasks are an extension in 2026-07-28. A server advertises them as capabilities.extensions["${TASKS_EXTENSION}"]; the core tasks capability was removed.`,
          fix: advertised
            ? 'Remove capabilities.tasks from the server/discover result. The extension entry is what 2026-07-28 clients read.'
            : ADVERTISE_FIX,
          evidence: [discover],
        }),
      );
      return findings;
    }

    // 3. Tasks served but advertised nowhere, so no client can discover them.
    if (!advertised) {
      const get = await ctx.call('tasks/get', { taskId: NONEXISTENT_TASK });
      if (!get.transportError && !isMethodNotFound(get)) {
        findings.push(
          finding(this, {
            title: 'tasks/get is served, but the tasks extension is not advertised',
            severity: 'warning',
            observed: `tasks/get returned ${describe(get)}, and server/discover advertises no tasks support.`,
            expected: `A server that serves tasks advertises capabilities.extensions["${TASKS_EXTENSION}"] in server/discover; clients do not probe for it.`,
            fix: ADVERTISE_FIX,
            evidence: [discover, get],
          }),
        );
      }
    }

    return findings;
  },
};
