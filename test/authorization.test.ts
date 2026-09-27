import { describe, expect, it } from 'vitest';
import type { ProbeContext } from '../src/probe/context.js';
import { MCP019 } from '../src/rules/MCP019.js';
import { runChecks } from '../src/run.js';
import { HttpTransport } from '../src/transport/http.js';
import type { MetadataFetch } from '../src/transport/types.js';
import { checkHttp } from './helpers.js';

async function withFixture<T>(
  mode: 'oauth-no-iss' | 'oauth-iss' | 'oauth-challenge' | 'modern',
  headers: Record<string, string>,
  body: (
    fixture: Awaited<
      ReturnType<typeof import('./fixtures/servers/http-server.mjs').startHttpFixture>
    >,
    report: Awaited<ReturnType<typeof runChecks>>,
  ) => T,
): Promise<T> {
  const { startHttpFixture } = await import('./fixtures/servers/http-server.mjs');
  const fixture = await startHttpFixture(mode);
  const transport = new HttpTransport(fixture.url, headers);
  try {
    const report = await runChecks(transport, { timeoutMs: 5000, only: ['MCP019'] });
    return body(fixture, report);
  } finally {
    await transport.close();
    await fixture.close();
  }
}

describe('MCP019 — RFC 9207 iss support (SEP-2468)', () => {
  it('warns when the authorization server metadata omits the flag', async () => {
    const report = await checkHttp('oauth-no-iss', { only: ['MCP019'] });
    expect(report.findings).toHaveLength(1);

    const f = report.findings[0]!;
    expect(f.severity).toBe('warning');
    expect(f.remediation).toBe('application');
    expect(f.observed).toMatch(
      /\/tenant1 .*has no authorization_response_iss_parameter_supported/,
    );
    expect(f.observed).toContain('/.well-known/oauth-authorization-server/tenant1');
    // SHOULD, not MUST: a missing flag never costs a server its READY.
    expect(report.ready).toBe(true);
  });

  it('passes when the flag is true, found through the OIDC fallback', async () => {
    await withFixture('oauth-iss', {}, (fixture, report) => {
      expect(report.findings).toEqual([]);
      // Path-inserted resource metadata, then RFC 8414 before OIDC Discovery.
      expect(fixture.metadataRequests.map((r) => r.path)).toEqual([
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/.well-known/openid-configuration',
      ]);
    });
  });

  it('follows the resource_metadata URL from a 401 challenge first', async () => {
    await withFixture('oauth-challenge', {}, (fixture, report) => {
      const f = report.findings.find((x) => x.ruleId === 'MCP019')!;
      expect(f.observed).toMatch(
        /sets authorization_response_iss_parameter_supported to false/,
      );
      expect(fixture.metadataRequests.map((r) => r.path)).toEqual([
        '/meta/protected-resource',
        '/.well-known/oauth-authorization-server/tenant2',
        '/.well-known/openid-configuration/tenant2',
        '/tenant2/.well-known/openid-configuration',
      ]);
    });
  });

  it('says nothing about a server that does not use OAuth', async () => {
    const report = await checkHttp('modern', { only: ['MCP019'] });
    expect(report.findings).toEqual([]);
  });

  it("never sends the user's headers to a metadata endpoint", async () => {
    // --header usually carries a bearer token, and the metadata can name any
    // host. Forwarding it would hand the token to whoever the metadata points at.
    await withFixture(
      'oauth-no-iss',
      { Authorization: 'Bearer do-not-leak', 'X-Api-Key': 'do-not-leak' },
      (fixture, report) => {
        expect(report.findings).toHaveLength(1);
        expect(fixture.metadataRequests.length).toBeGreaterThan(0);
        for (const r of fixture.metadataRequests) {
          expect(JSON.stringify(r.headers)).not.toContain('do-not-leak');
        }
      },
    );
  });
});

describe('MCP019 against a stubbed fetcher', () => {
  /** A context whose metadata fetches are answered from `docs`, and logged. */
  function stubContext(docs: Record<string, unknown>) {
    const fetched: string[] = [];
    const ctx = {
      target: 'https://mcp.example.com/mcp',
      kind: 'http',
      transcript: [],
      transport: {
        fetchMetadata: async (url: string): Promise<MetadataFetch> => {
          fetched.push(url);
          return url in docs
            ? { url, status: 200, json: docs[url] }
            : { url, status: 0, error: 'connect ECONNREFUSED' };
        },
      },
    } as unknown as ProbeContext;
    return { ctx, fetched };
  }

  const PRM = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

  it('skips an authorization server it cannot reach', async () => {
    const { ctx } = stubContext({
      [PRM]: { authorization_servers: ['https://auth.example.com'] },
    });
    expect(await MCP019.run(ctx)).toEqual([]);
  });

  it('ignores metadata that is not the shape it claims to be', async () => {
    const { ctx } = stubContext({
      [PRM]: { authorization_servers: [42, null, 'not a url'] },
      'https://mcp.example.com/.well-known/oauth-protected-resource': [],
    });
    expect(await MCP019.run(ctx)).toEqual([]);
  });

  it('checks at most five authorization servers', async () => {
    const issuers = Array.from({ length: 20 }, (_, i) => `https://as${i}.example.com`);
    const { ctx, fetched } = stubContext({ [PRM]: { authorization_servers: issuers } });
    await MCP019.run(ctx);
    const hosts = new Set(
      fetched.map((u) => new URL(u).host).filter((h) => h.startsWith('as')),
    );
    expect(hosts.size).toBe(5);
  });

  it('reports each authorization server that lacks the flag', async () => {
    const { ctx } = stubContext({
      [PRM]: {
        authorization_servers: ['https://a.example.com', 'https://b.example.com'],
      },
      'https://a.example.com/.well-known/oauth-authorization-server': {
        issuer: 'https://a.example.com',
      },
      'https://b.example.com/.well-known/oauth-authorization-server': {
        issuer: 'https://b.example.com',
        authorization_response_iss_parameter_supported: true,
      },
    });
    const findings = await MCP019.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.observed).toContain('https://a.example.com');
  });
});

describe('MCP020 — Dynamic Client Registration without CIMD', () => {
  it('warns when DCR is the only registration path offered', async () => {
    const report = await checkHttp('oauth-no-iss', { only: ['MCP020'] });
    expect(report.findings).toHaveLength(1);

    const f = report.findings[0]!;
    expect(f.severity).toBe('warning');
    expect(f.remediation).toBe('application');
    expect(f.observed).toMatch(/\/tenant1 .*advertises a registration_endpoint/);
    expect(report.ready).toBe(true);
  });

  it('passes an authorization server that offers CIMD alongside DCR', async () => {
    const report = await checkHttp('oauth-iss', { only: ['MCP020'] });
    expect(report.findings).toEqual([]);
  });

  it('does not fault pre-registration, which offers neither', async () => {
    const report = await checkHttp('oauth-challenge', { only: ['MCP020'] });
    expect(report.findings).toEqual([]);
  });

  it('says nothing about a server that does not use OAuth', async () => {
    const report = await checkHttp('modern', { only: ['MCP020'] });
    expect(report.findings).toEqual([]);
  });

  it('shares one discovery with MCP019 rather than fetching twice', async () => {
    const { startHttpFixture } = await import('./fixtures/servers/http-server.mjs');
    const fixture = await startHttpFixture('oauth-iss');
    const transport = new HttpTransport(fixture.url);
    try {
      await runChecks(transport, { timeoutMs: 5000, only: ['MCP019', 'MCP020'] });
      // The same three requests MCP019 alone makes.
      expect(fixture.metadataRequests).toHaveLength(3);
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
});
