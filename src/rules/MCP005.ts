import {
  effectiveToolsList,
  resultOf,
  succeeded,
  type ProbeContext,
} from '../probe/context.js';
import type { Exchange } from '../transport/types.js';
import { specUrl } from '../protocol.js';
import { finding, type Finding, type Rule } from './types.js';

const VALID_SCOPES = new Set(['public', 'private']);

const CACHEABLE_METHODS =
  'tools/list, prompts/list, resources/list, resources/read and resources/templates/list';

/** One cacheable result to inspect, and the method that produced it. */
interface Cacheable {
  method: string;
  ex: Exchange;
  result: Record<string, any>;
}

/**
 * The first URI `resources/list` returned, if any.
 *
 * `resources/read` needs a real URI to return a result at all, and guessing
 * one would only ever exercise the not-found path, which MCP011 owns.
 */
function firstResourceUri(result: Record<string, any> | undefined): string | undefined {
  const resources = result?.['resources'];
  if (!Array.isArray(resources)) return undefined;
  const uri = resources[0]?.uri;
  return typeof uri === 'string' ? uri : undefined;
}

/**
 * Collect every cacheable result the server produced.
 *
 * A method that errors is skipped rather than faulted. Method-not-found is the
 * common case, since not every server implements prompts or resources, and a
 * missing feature is not a caching violation. Any other error leaves no result
 * to judge, and a probe that got no answer already makes the run incomplete.
 */
async function collect(ctx: ProbeContext): Promise<Cacheable[]> {
  const found: Cacheable[] = [];
  const add = (method: string, ex: Exchange | null): Record<string, any> | undefined => {
    if (!ex || !succeeded(ex)) return undefined;
    const result = resultOf(ex);
    if (result) found.push({ method, ex, result });
    return result;
  };

  add('tools/list', effectiveToolsList(ctx));
  add('prompts/list', await ctx.call('prompts/list', {}));
  const resources = add('resources/list', await ctx.call('resources/list', {}));
  add('resources/templates/list', await ctx.call('resources/templates/list', {}));

  const uri = firstResourceUri(resources);
  if (uri !== undefined) add('resources/read', await ctx.call('resources/read', { uri }));

  return found;
}

/** `tools/list` and `prompts/list`, or just `tools/list`. */
function methodList(items: Cacheable[]): string {
  const names = items.map((c) => c.method);
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * SEP-2549 made list and read results cacheable, requiring `ttlMs` and
 * `cacheScope`. Now that list endpoints no longer vary per connection, these
 * are what let clients and intermediaries stop re-polling — a large part of
 * the practical win from going stateless.
 *
 * Findings are grouped by field, not by method. The fields are emitted by the
 * SDK's result plumbing, so one missing field is one defect however many
 * methods show it, and a finding per method would inflate the error count of
 * a server that needs a single upgrade.
 */
export const MCP005: Rule = {
  id: 'MCP005',
  title: 'List results are missing the required ttlMs and cacheScope fields',
  remediation: 'sdk',
  severity: 'error',
  specRef: specUrl('server/utilities/caching'),
  changelogRef: 'Minor change 5 (SEP-2549)',
  appliesTo: ['stdio', 'http'],

  async run(ctx: ProbeContext): Promise<Finding[]> {
    const results = await collect(ctx);
    const findings: Finding[] = [];

    const badTtl = results.filter((c) => typeof c.result['ttlMs'] !== 'number');
    if (badTtl.length > 0) {
      findings.push(
        finding(this, {
          observed: badTtl
            .map((c) => {
              const ttl = c.result['ttlMs'];
              return ttl === undefined
                ? `The ${c.method} result has no ttlMs field.`
                : `${c.method} returned ttlMs: ${JSON.stringify(ttl)}, which is not a number.`;
            })
            .join(' '),
          expected: `Results from ${CACHEABLE_METHODS} implement CacheableResult, carrying ttlMs as a freshness hint in milliseconds.`,
          fix: `Add a numeric ttlMs to the ${methodList(badTtl)} result${badTtl.length > 1 ? 's' : ''}. Use 0 if a result must never be cached.`,
          evidence: badTtl.map((c) => c.ex),
        }),
      );
    }

    const badScope = results.filter((c) => {
      const scope = c.result['cacheScope'];
      return typeof scope !== 'string' || !VALID_SCOPES.has(scope);
    });
    if (badScope.length > 0) {
      findings.push(
        finding(this, {
          title: 'List results are missing a valid cacheScope',
          observed: badScope
            .map((c) => {
              const scope = c.result['cacheScope'];
              return scope === undefined
                ? `The ${c.method} result has no cacheScope field.`
                : `${c.method} returned cacheScope: ${JSON.stringify(scope)}.`;
            })
            .join(' '),
          expected: 'cacheScope is "public" or "private".',
          fix: `Add cacheScope to the ${methodList(badScope)} result${badScope.length > 1 ? 's' : ''}. Use "private" when the response depends on the authenticated caller, "public" when a shared intermediary may cache it.`,
          evidence: badScope.map((c) => c.ex),
        }),
      );
    }

    return findings;
  },
};
