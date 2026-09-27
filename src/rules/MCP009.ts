import { isMethodNotFound, type ProbeContext } from '../probe/context.js';
import { specUrl } from '../protocol.js';
import { serverCapabilities } from './helpers.js';
import { describe, finding, type Finding, type Rule } from './types.js';

const LIST_CHANGED_CAPS = ['tools', 'prompts', 'resources'] as const;

/**
 * A server that advertises `listChanged` is promising to tell clients when its
 * listings change. Under 2026-07-28 the only way to deliver on that promise is
 * `subscriptions/listen`, so advertising one without the other is a broken
 * contract rather than a style issue.
 */
export const MCP009: Rule = {
  id: 'MCP009',
  title: 'subscriptions/listen is missing despite advertised listChanged capabilities',
  // Empirically 'sdk': migrating the notes server in docs/migration-walkthrough.md
  // cleared this with no application change, because the v2 SDK implements
  // subscriptions/listen while still defaulting tools.listChanged to true. The
  // capability is nominally the author's declaration, but the promise is kept
  // by the framework, so attributing it to the author sent people looking at
  // code that was never the problem.
  remediation: 'sdk',
  severity: 'error',
  specRef: specUrl('server/utilities/subscriptions'),
  changelogRef: 'Major change 4 (SEP-2575)',
  appliesTo: ['stdio', 'http'],

  async run(ctx: ProbeContext): Promise<Finding[]> {
    const caps = serverCapabilities(ctx);
    const advertised = LIST_CHANGED_CAPS.filter((key) => caps[key]?.listChanged === true);
    if (advertised.length === 0) return [];

    // A working implementation holds the stream open and never sends a
    // response: it answers with notifications/subscriptions/acknowledged,
    // tagged with our request id, and the transport resolves on that. Only an
    // explicit method-not-found is a finding. Silence is neither a pass nor a
    // finding — it is an unanswered probe, and makes the run incomplete.
    const ex = await ctx.call(
      'subscriptions/listen',
      // Field name and shape per SubscriptionFilter in the 2026-07-28 schema.
      { notifications: { toolsListChanged: true } },
      { timeoutMs: 2500, acknowledgedBy: 'notifications/subscriptions/acknowledged' },
    );

    if (!isMethodNotFound(ex)) return [];

    return [
      finding(this, {
        observed:
          `The server advertises listChanged for ${advertised.join(', ')}, ` +
          `but subscriptions/listen returned ${describe(ex)}.`,
        expected:
          'Change notifications are delivered over subscriptions/listen, a single long-lived POST-response stream clients opt into.',
        fix: 'Either implement subscriptions/listen, or stop advertising listChanged for capabilities you cannot notify on. The old HTTP GET stream is no longer an option.',
        evidence: [ex],
      }),
    ];
  },
};
