import { describe, expect, it } from 'vitest';

import {
  parseRunSnapshot,
  summarise,
  type RunSnapshot,
  type TargetResult,
} from '../scripts/aggregate-index.mjs';

/**
 * A snapshot with the given results and sane defaults elsewhere.
 *
 * Results are cast because several tests deliberately pass malformed ones to
 * `parseRunSnapshot`, which is the function whose job is to reject them.
 */
function snapshot(results: unknown[]): RunSnapshot {
  return {
    schemaVersion: 1,
    scannedAt: '2026-09-07T06:04:11.000Z',
    toolVersion: '1.0.0',
    rulesetSize: 18,
    results: results as TargetResult[],
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    id: 'a',
    package: '@example/server-a',
    version: '1.0.0',
    transport: 'stdio',
    ready: false,
    errorCount: 4,
    warningCount: 1,
    sdkErrors: 3,
    applicationErrors: 1,
    failedRules: ['MCP001', 'MCP004'],
    unreachable: null,
    ...over,
  };
}

describe('parseRunSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const parsed = parseRunSnapshot(JSON.stringify(snapshot([result()])));
    expect(parsed.results).toHaveLength(1);
  });

  it('rejects a snapshot from a future schema', () => {
    const text = JSON.stringify({ ...snapshot([result()]), schemaVersion: 2 });
    expect(() => parseRunSnapshot(text)).toThrow(/schemaVersion/);
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseRunSnapshot('not json')).toThrow(/JSON/);
  });

  it('rejects a result missing a required field', () => {
    const broken = result();
    delete (broken as Record<string, unknown>)['errorCount'];
    expect(() => parseRunSnapshot(JSON.stringify(snapshot([broken])))).toThrow(
      /errorCount/,
    );
  });

  it('rejects a snapshot carrying evidence', () => {
    // Storing other people's wire traffic is a design violation, so the
    // parser refuses it rather than trusting the writer.
    const withEvidence = { ...result(), evidence: [{ request: {} }] };
    expect(() => parseRunSnapshot(JSON.stringify(snapshot([withEvidence])))).toThrow(
      /evidence/,
    );
  });
});

describe('summarise', () => {
  it('derives the date from scannedAt', () => {
    expect(summarise(snapshot([result()])).date).toBe('2026-09-07');
  });

  it('counts ready, measured and unreachable separately', () => {
    const row = summarise(
      snapshot([
        result({
          id: 'a',
          ready: true,
          errorCount: 0,
          sdkErrors: 0,
          applicationErrors: 0,
          failedRules: [],
        }),
        result({ id: 'b' }),
        result({ id: 'c', unreachable: 'install failed' }),
      ]),
    );
    expect(row.cohortSize).toBe(3);
    expect(row.measured).toBe(2);
    expect(row.unreachable).toBe(1);
    expect(row.ready).toBe(1);
  });

  it('excludes unreachable targets from every total', () => {
    const row = summarise(
      snapshot([
        result({ id: 'a', errorCount: 4, sdkErrors: 3, applicationErrors: 1 }),
        result({
          id: 'b',
          unreachable: 'never answered',
          errorCount: 99,
          sdkErrors: 99,
          applicationErrors: 99,
          failedRules: ['MCP002'],
        }),
      ]),
    );
    expect(row.sdkErrors).toBe(3);
    expect(row.applicationErrors).toBe(1);
    expect(row.ruleFailureCounts).toEqual({ MCP001: 1, MCP004: 1 });
  });

  it('reports a null median when nothing was measurable', () => {
    const row = summarise(snapshot([result({ unreachable: 'install failed' })]));
    expect(row.measured).toBe(0);
    expect(row.medianErrors).toBeNull();
  });

  it('averages the two middle values for an even cohort', () => {
    const row = summarise(
      snapshot([
        result({ id: 'a', errorCount: 2 }),
        result({ id: 'b', errorCount: 4 }),
        result({ id: 'c', errorCount: 5 }),
        result({ id: 'd', errorCount: 9 }),
      ]),
    );
    expect(row.medianErrors).toBe(4.5);
  });

  it('carries toolVersion and rulesetSize so a trend cannot silently redefine itself', () => {
    const row = summarise(snapshot([result()]));
    expect(row.toolVersion).toBe('1.0.0');
    expect(row.rulesetSize).toBe(18);
  });

  it('sorts ruleFailureCounts by rule id', () => {
    const row = summarise(
      snapshot([result({ failedRules: ['MCP012', 'MCP002', 'MCP001'] })]),
    );
    expect(Object.keys(row.ruleFailureCounts)).toEqual(['MCP001', 'MCP002', 'MCP012']);
  });
});
