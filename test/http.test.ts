import { describe, expect, it } from 'vitest';
import { checkHttp, crashedRules, ruleIds } from './helpers.js';
import { HttpTransport } from '../src/transport/http.js';
import { modernMeta } from '../src/probe/context.js';
import { TARGET_REVISION } from '../src/protocol.js';

describe('http — legacy 2025-11-25 server', () => {
  it('reports the transport-level breaking changes', async () => {
    const report = await checkHttp('legacy');

    expect(crashedRules(report)).toEqual([]);
    expect(report.ready).toBe(false);
    expect(ruleIds(report, 'error')).toEqual(
      expect.arrayContaining([
        'MCP003', // Mcp-Session-Id still minted
        'MCP010', // GET stream endpoint still served
      ]),
    );
  });

  it('flags the deprecated HTTP+SSE handshake', async () => {
    const report = await checkHttp('legacy', { only: ['MCP016'] });
    const finding = report.findings.find((f) => f.ruleId === 'MCP016')!;
    expect(finding.severity).toBe('warning');
    expect(finding.observed).toMatch(/endpoint/);
  });

  it('detects the pre-renumbering HeaderMismatch code', async () => {
    const report = await checkHttp('legacy', { only: ['MCP012'] });
    const titles = report.findings.map((f) => f.title);
    expect(titles).toContain('HeaderMismatch still uses the pre-renumbering code');
  });

  it('quotes the offending session header as evidence', async () => {
    const report = await checkHttp('legacy', { only: ['MCP003'] });
    const finding = report.findings.find((f) => f.ruleId === 'MCP003')!;
    expect(finding.observed).toContain('fixture-session-1');
    expect(finding.evidence.length).toBeGreaterThan(0);
  });
});

describe('http — compliant 2026-07-28 server', () => {
  it('reports nothing at all', async () => {
    const report = await checkHttp('modern');

    expect(crashedRules(report)).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('runs every http rule', async () => {
    const report = await checkHttp('modern');
    expect(report.outcomes.length).toBe(21);
  });
});

describe('http — server that rejects the routing headers', () => {
  it('identifies MCP014 as the cause', async () => {
    const report = await checkHttp('strict-headers');
    expect(crashedRules(report)).toEqual([]);

    const finding = report.findings.find((f) => f.ruleId === 'MCP014')!;
    expect(finding).toBeDefined();
    expect(finding.observed).toMatch(/succeeded without them/);
  });

  it('does not also blame the _meta envelope', async () => {
    // Both MCP013 and MCP014 look for "fails one way, succeeds another".
    // MCP013's control call still carries the headers, so it must stay quiet.
    const report = await checkHttp('strict-headers');
    expect(ruleIds(report)).not.toContain('MCP013');
  });
});

describe('http transport — required standard headers', () => {
  /**
   * Regression: the transport never sent MCP-Protocol-Version, which SEP-2243
   * requires on every modern POST. A real SDK v2 server rejected every probe
   * with -32020, and seven rules reported findings that were entirely our
   * fault. The header must also *match* the _meta envelope, so it is mirrored
   * from the body rather than hardcoded.
   */
  it('sends MCP-Protocol-Version matching the _meta envelope', async () => {
    const { startHttpFixture } = await import('./fixtures/servers/http-server.mjs');
    const fixture = await startHttpFixture('modern');
    const transport = new HttpTransport(fixture.url);
    try {
      const ex = await transport.send({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: { _meta: modernMeta() },
      });
      expect(ex.requestHeaders['mcp-protocol-version']).toBe(TARGET_REVISION);
      expect(ex.requestHeaders['mcp-method']).toBe('tools/list');
    } finally {
      await transport.close();
      await fixture.close();
    }
  });

  it('mirrors an overridden version so version probes are not masked', async () => {
    // MCP012 sends an unsupported version deliberately. If the header stayed
    // pinned to the real revision the server would answer HeaderMismatch and
    // the rule would never see the version rejection it is testing for.
    const { startHttpFixture } = await import('./fixtures/servers/http-server.mjs');
    const fixture = await startHttpFixture('modern');
    const transport = new HttpTransport(fixture.url);
    try {
      const ex = await transport.send({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {
          _meta: {
            ...modernMeta(),
            'io.modelcontextprotocol/protocolVersion': '1999-01-01',
          },
        },
      });
      expect(ex.requestHeaders['mcp-protocol-version']).toBe('1999-01-01');
    } finally {
      await transport.close();
      await fixture.close();
    }
  });

  it('omits the header entirely on a legacy-era request', async () => {
    // No _meta means a pre-2026 client by construction; sending the header
    // would misclassify the request's era.
    const { startHttpFixture } = await import('./fixtures/servers/http-server.mjs');
    const fixture = await startHttpFixture('modern');
    const transport = new HttpTransport(fixture.url);
    try {
      const ex = await transport.send({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
      });
      expect(ex.requestHeaders['mcp-protocol-version']).toBeUndefined();
    } finally {
      await transport.close();
      await fixture.close();
    }
  });
});

describe('http — MCP005 across every CacheableResult method', () => {
  it('catches a server whose tools/list is compliant but other methods are not', async () => {
    const report = await checkHttp('partial-cache', { only: ['MCP005'] });
    expect(report.ready).toBe(false);
    const ttl = report.findings.find((f) => /ttlMs/.test(f.observed))!;
    expect(ttl.observed).toContain('prompts/list');
    expect(ttl.observed).toContain('resources/read');
    expect(ttl.observed).not.toContain('tools/list');
  });
});

describe('http — subscriptions/listen is a held event stream', () => {
  it('certifies a server that acknowledges the stream and holds it open', async () => {
    const report = await checkHttp('list-changed');
    expect(report.incomplete).toBeUndefined();
    expect(report.findings).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('still calls total silence unanswered', async () => {
    const report = await checkHttp('silent-listen');
    expect(report.ready).toBe(false);
    expect(report.incomplete?.failed).toBe(1);
  });
});
