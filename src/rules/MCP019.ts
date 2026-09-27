import type { ProbeContext } from '../probe/context.js';
import { specUrl } from '../protocol.js';
import type { MetadataFetch, Transport } from '../transport/types.js';
import { finding, type Finding, type Rule } from './types.js';

/** Enough for any real deployment, and a bound on a hostile metadata document. */
const MAX_AUTHORIZATION_SERVERS = 5;

/** A JSON object body from a 200, or `undefined`. */
function documentOf(res: MetadataFetch): Record<string, unknown> | undefined {
  const json = res.json;
  if (res.status !== 200 || !json || typeof json !== 'object' || Array.isArray(json)) {
    return undefined;
  }
  return json as Record<string, unknown>;
}

/** `https://host/a/b/` → `/a/b`; a bare origin → `''`. */
function pathOf(url: URL): string {
  return url.pathname.replace(/\/+$/, '');
}

/** The `resource_metadata` URL from any 401/403 challenge the run received. */
function challengedMetadataUrl(ctx: ProbeContext): string | undefined {
  for (const ex of ctx.transcript) {
    if (ex.status !== 401 && ex.status !== 403) continue;
    const challenge = ex.responseHeaders['www-authenticate'];
    const m = challenge?.match(/resource_metadata\s*=\s*"([^"]+)"/i);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Where a client looks for Protected Resource Metadata (RFC 9728), in the
 * order the spec requires: the challenge's `resource_metadata` when there is
 * one, then the well-known URI with the endpoint's path inserted, then the
 * root.
 */
function protectedResourceCandidates(ctx: ProbeContext): string[] {
  const endpoint = new URL(ctx.target);
  const path = pathOf(endpoint);
  const candidates = [
    challengedMetadataUrl(ctx),
    path ? `${endpoint.origin}/.well-known/oauth-protected-resource${path}` : undefined,
    `${endpoint.origin}/.well-known/oauth-protected-resource`,
  ];
  return [...new Set(candidates.filter((u): u is string => u !== undefined))];
}

/**
 * Where a client looks for authorization server metadata, in the order the
 * spec requires: RFC 8414 first, then the two OpenID Connect Discovery forms.
 */
function authorizationServerCandidates(issuer: string): string[] {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [];
  }
  const path = pathOf(url);
  return path
    ? [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ]
    : [
        `${url.origin}/.well-known/oauth-authorization-server`,
        `${url.origin}/.well-known/openid-configuration`,
      ];
}

/** The first candidate that returns a JSON object, with where it came from. */
async function firstDocument(
  transport: Required<Pick<Transport, 'fetchMetadata'>>,
  candidates: string[],
): Promise<{ url: string; doc: Record<string, unknown> } | undefined> {
  for (const url of candidates) {
    const doc = documentOf(await transport.fetchMetadata(url));
    if (doc) return { url, doc };
  }
  return undefined;
}

/**
 * SEP-2468 brought RFC 9207 into MCP: an authorization server SHOULD return
 * `iss` in its authorization responses, and advertise that it does with
 * `authorization_response_iss_parameter_supported`. Without it a client
 * talking to more than one authorization server cannot tell which one a
 * response came from — the opening a mix-up attack needs — and the spec's own
 * validation table leaves such a client nothing to check.
 *
 * This inspects published metadata only. It never starts an authorization
 * flow, and never sends the user's headers to the hosts the metadata names.
 */
export const MCP019: Rule = {
  id: 'MCP019',
  title: 'Authorization server does not advertise RFC 9207 iss support',
  remediation: 'application',
  severity: 'warning',
  specRef: specUrl('basic/authorization'),
  changelogRef: 'Minor change 7 (SEP-2468)',
  appliesTo: ['http'],

  async run(ctx: ProbeContext): Promise<Finding[]> {
    const { transport } = ctx;
    if (!transport.fetchMetadata) return [];
    const fetcher = { fetchMetadata: transport.fetchMetadata.bind(transport) };

    // No Protected Resource Metadata means the server does not use OAuth, and
    // there is nothing here to check.
    const resource = await firstDocument(fetcher, protectedResourceCandidates(ctx));
    if (!resource) return [];

    const listed = resource.doc['authorization_servers'];
    if (!Array.isArray(listed)) return [];
    const issuers = listed
      .filter((s): s is string => typeof s === 'string')
      .slice(0, MAX_AUTHORIZATION_SERVERS);

    const findings: Finding[] = [];
    for (const issuer of issuers) {
      // An authorization server we cannot reach or parse tells us nothing
      // about its iss support, and is not the MCP server's failure.
      const as = await firstDocument(fetcher, authorizationServerCandidates(issuer));
      if (!as) continue;

      const flag = as.doc['authorization_response_iss_parameter_supported'];
      if (flag === true) continue;

      findings.push(
        finding(this, {
          observed:
            flag === undefined
              ? `The metadata for authorization server ${issuer} (${as.url}) has no authorization_response_iss_parameter_supported field.`
              : `The metadata for authorization server ${issuer} (${as.url}) sets authorization_response_iss_parameter_supported to ${JSON.stringify(flag)}.`,
          expected:
            'MCP authorization servers SHOULD include iss in authorization responses (RFC 9207), and advertise it by setting authorization_response_iss_parameter_supported to true.',
          fix: `Enable the iss authorization response parameter on ${issuer} and publish authorization_response_iss_parameter_supported: true in its metadata. With a hosted identity provider this is usually a setting, not code.`,
          evidence: [],
        }),
      );
    }
    return findings;
  },
};
