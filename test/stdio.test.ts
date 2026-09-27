import { describe, expect, it } from 'vitest';
import { checkStdio, crashedRules, ruleIds } from './helpers.js';

describe('stdio — legacy 2025-11-25 server', () => {
  it('reports every applicable breaking change', async () => {
    const report = await checkStdio('legacy');

    expect(crashedRules(report)).toEqual([]);
    expect(report.ready).toBe(false);
    expect(ruleIds(report, 'error')).toEqual([
      'MCP001', // server/discover missing
      'MCP002', // still requires initialize
      'MCP004', // no resultType
      'MCP005', // no ttlMs / cacheScope
      'MCP006', // ping still live
      'MCP007', // logging/setLevel still live
      'MCP008', // resources/subscribe still live
      'MCP009', // listChanged advertised, subscriptions/listen missing
      'MCP011', // -32002 for resource not found
      'MCP012', // -32004 not renumbered
      'MCP021', // tasks/list still live
    ]);
  });

  it('reports the deprecation advisories', async () => {
    const report = await checkStdio('legacy');
    expect(ruleIds(report, 'warning')).toEqual(
      expect.arrayContaining(['MCP015', 'MCP017', 'MCP018']),
    );
  });

  it('does not blame _meta handling when the real cause is the handshake', async () => {
    // MCP013 and MCP002 both key off a failed bare tools/list. Only MCP002
    // should claim it.
    const report = await checkStdio('legacy');
    expect(ruleIds(report)).not.toContain('MCP013');
  });

  it('reports both symptoms of the removed handshake', async () => {
    const report = await checkStdio('legacy', { only: ['MCP002'] });
    const titles = report.findings.map((f) => f.title);
    expect(titles).toContain('Server still requires the initialize handshake');
    expect(titles).toContain('Server still accepts the removed initialize method');
  });

  it('skips http-only rules', async () => {
    const report = await checkStdio('legacy');
    const ran = report.outcomes.map((o) => o.rule.id);
    for (const httpOnly of ['MCP003', 'MCP010', 'MCP014', 'MCP016']) {
      expect(ran).not.toContain(httpOnly);
    }
  });
});

describe('stdio — compliant 2026-07-28 server', () => {
  it('reports nothing at all', async () => {
    const report = await checkStdio('modern');

    expect(crashedRules(report)).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.warningCount).toBe(0);
  });

  it('runs every stdio rule', async () => {
    const report = await checkStdio('modern');
    expect(report.outcomes.length).toBe(15);
  });
});

describe('stdio — server that rejects the _meta envelope', () => {
  it('isolates the cause to MCP013', async () => {
    const report = await checkStdio('strict-params');
    expect(crashedRules(report)).toEqual([]);
    expect(ruleIds(report, 'error')).toContain('MCP013');

    const finding = report.findings.find((f) => f.ruleId === 'MCP013')!;
    expect(finding.observed).toMatch(/succeeded when _meta was omitted/);
  });
});

describe('MCP005 — every CacheableResult method, not just tools/list', () => {
  const ALL_FIVE = [
    'tools/list',
    'prompts/list',
    'resources/list',
    'resources/templates/list',
    'resources/read',
  ];

  it('names all five methods on a legacy server, one finding per field', async () => {
    const report = await checkStdio('legacy', { only: ['MCP005'] });
    expect(report.findings).toHaveLength(2);

    for (const f of report.findings) {
      for (const method of ALL_FIVE) expect(f.observed).toContain(method);
      expect(f.evidence.map((ex) => ex.request.method).sort()).toEqual(
        [...ALL_FIVE].sort(),
      );
    }
  });

  it('reads a resource the server listed, not a guessed URI', async () => {
    const report = await checkStdio('legacy', { only: ['MCP005'] });
    const read = report.findings[0]!.evidence.find(
      (ex) => ex.request.method === 'resources/read',
    )!;
    expect(read.request.params).toMatchObject({ uri: 'fixture://notes/readme' });
  });

  it('catches a server whose tools/list is compliant but other methods are not', async () => {
    // Before this rule covered all five methods, this server passed.
    const report = await checkStdio('partial-cache', { only: ['MCP005'] });
    expect(report.ready).toBe(false);
    expect(report.findings).toHaveLength(2);

    const ttl = report.findings.find((f) => /ttlMs/.test(f.observed))!;
    expect(ttl.observed).toContain('prompts/list');
    expect(ttl.observed).toContain('resources/read');
    expect(ttl.observed).not.toContain('tools/list');
    expect(ttl.fix).toContain('prompts/list and resources/read results');
  });

  it('does not fault a server that implements no prompts or resources', async () => {
    const report = await checkStdio('tools-only', { only: ['MCP005'] });
    expect(report.findings).toEqual([]);
    expect(report.ready).toBe(true);
  });
});

describe('rule selection', () => {
  it('honours --only', async () => {
    const report = await checkStdio('legacy', { only: ['MCP006'] });
    expect(report.outcomes.map((o) => o.rule.id)).toEqual(['MCP006']);
  });

  it('honours --skip', async () => {
    const report = await checkStdio('legacy', { skip: ['MCP001', 'MCP002'] });
    const ran = report.outcomes.map((o) => o.rule.id);
    expect(ran).not.toContain('MCP001');
    expect(ran).not.toContain('MCP002');
    expect(ran).toContain('MCP006');
  });
});

describe('stdio — dual-era server', () => {
  /**
   * Regression: this reported NOT READY against the SDK's own `caching`
   * example, which serves both eras. Dual-era is the migration path the SDK
   * documents as the recommended first step, so failing it inverted the
   * tool's advice for servers that had done the right thing.
   */
  it('is READY, with the legacy handshake reported as an advisory', async () => {
    const report = await checkStdio('dual-era');

    expect(crashedRules(report)).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.errorCount).toBe(0);

    const dual = report.findings.find((f) => f.ruleId === 'MCP002')!;
    expect(dual).toBeDefined();
    expect(dual.severity).toBe('warning');
    expect(dual.title).toMatch(/dual-era/);
    expect(dual.fix).toMatch(/No action needed today/);
  });

  it('still calls a legacy-only server NOT READY', async () => {
    // The dual-era carve-out keys off server/discover working. A server with
    // no discover and a live initialize must stay an error.
    const report = await checkStdio('legacy', { only: ['MCP002'] });
    expect(report.findings.some((f) => f.severity === 'error')).toBe(true);
  });
});

describe('MCP021 — tasks moved to the io.modelcontextprotocol/tasks extension', () => {
  const mcp021 = (report: Awaited<ReturnType<typeof checkStdio>>) =>
    report.findings.filter((f) => f.ruleId === 'MCP021');

  it('reports tasks/list as still live on a legacy server', async () => {
    const findings = mcp021(await checkStdio('legacy', { only: ['MCP021'] }));
    const list = findings.find((f) => f.observed.startsWith('tasks/list'))!;
    expect(list.severity).toBe('error');
    // tasks/result is registered but rejected our unknown task id: the handler
    // is still there, worded as a warning like every removed-method check.
    const result = findings.find((f) => f.observed.startsWith('tasks/result'))!;
    expect(result.severity).toBe('warning');
  });

  it('is an error when tasks are declared only in core capabilities', async () => {
    const findings = mcp021(await checkStdio('core-tasks', { only: ['MCP021'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.observed).toMatch(/declares capabilities\.tasks/);
    expect(findings[0]!.fix).toContain('capabilities.extensions');
  });

  it('is only a warning when the stale core key sits beside the extension', async () => {
    const findings = mcp021(await checkStdio('core-and-ext', { only: ['MCP021'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.fix).toMatch(/Remove capabilities\.tasks/);
  });

  it('warns when tasks/get is served but advertised nowhere', async () => {
    const findings = mcp021(await checkStdio('hidden-tasks', { only: ['MCP021'] }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.observed).toMatch(/^tasks\/get returned/);
  });

  it('passes a server that advertises the extension', async () => {
    const report = await checkStdio('tasks-ext', { only: ['MCP021'] });
    expect(mcp021(report)).toEqual([]);
    expect(report.ready).toBe(true);
  });

  it('passes a server with no tasks at all', async () => {
    expect(mcp021(await checkStdio('modern', { only: ['MCP021'] }))).toEqual([]);
  });

  it('does not fault a dual-era server for its 2025-11-25 answers', async () => {
    // Its initialize result is a legacy answer, where core tasks are correct;
    // only server/discover speaks for the 2026-07-28 era.
    expect(mcp021(await checkStdio('dual-era', { only: ['MCP021'] }))).toEqual([]);
  });
});
