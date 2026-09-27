import type { ProbeContext } from '../probe/context.js';
import type { MetadataFetch } from '../transport/types.js';

/**
 * OAuth discovery, shared by the rules that inspect authorization server
 * metadata (MCP019, MCP020).
 *
 * Metadata inspection only: nothing here starts an authorization flow, and
 * every fetch goes through `Transport.fetchMetadata`, which never carries the
 * user's headers to the hosts the metadata names.
 */

/** Enough for any real deployment, and a bound on a hostile metadata document. */
const MAX_AUTHORIZATION_SERVERS = 5;

/** One authorization server whose metadata was found. */
export interface AuthorizationServer {
  /** The issuer, as the Protected Resource Metadata listed it. */
  issuer: string;
  /** Where its metadata was found. */
  url: string;
  doc: Record<string, unknown>;
}

type Fetch = (url: string) => Promise<MetadataFetch>;

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
  fetch: Fetch,
  candidates: string[],
): Promise<{ url: string; doc: Record<string, unknown> } | undefined> {
  for (const url of candidates) {
    const doc = documentOf(await fetch(url));
    if (doc) return { url, doc };
  }
  return undefined;
}

async function discover(ctx: ProbeContext, fetch: Fetch): Promise<AuthorizationServer[]> {
  // No Protected Resource Metadata means the server does not use OAuth.
  const resource = await firstDocument(fetch, protectedResourceCandidates(ctx));
  if (!resource) return [];

  const listed = resource.doc['authorization_servers'];
  if (!Array.isArray(listed)) return [];
  const issuers = listed
    .filter((s): s is string => typeof s === 'string')
    .slice(0, MAX_AUTHORIZATION_SERVERS);

  const found: AuthorizationServer[] = [];
  for (const issuer of issuers) {
    // An authorization server we cannot reach or parse tells us nothing, and
    // is not the MCP server's failure.
    const as = await firstDocument(fetch, authorizationServerCandidates(issuer));
    if (as) found.push({ issuer, ...as });
  }
  return found;
}

/** One discovery per run, however many rules ask. */
const cache = new WeakMap<ProbeContext, Promise<AuthorizationServer[]>>();

/**
 * The authorization servers an HTTP MCP server's metadata leads to, with
 * their metadata. Empty for a server that does not use OAuth, and for stdio.
 */
export function authorizationServers(ctx: ProbeContext): Promise<AuthorizationServer[]> {
  const { transport } = ctx;
  if (!transport.fetchMetadata) return Promise.resolve([]);

  let pending = cache.get(ctx);
  if (!pending) {
    pending = discover(ctx, (url) => transport.fetchMetadata!(url));
    cache.set(ctx, pending);
  }
  return pending;
}
