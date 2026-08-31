import { describe, expect, it } from 'vitest';

import {
  parseRunSnapshot,
  summarise,
  type RunSnapshot,
  type TargetResult,
} from '../scripts/aggregate-index.mjs';

/**
 * A valid result. The return type is annotated rather than cast, so TypeScript
 * checks this fixture against the declared contract — an earlier version cast
 * it and gave the .d.mts zero type-level coverage.
 */
function goodResult(over: Partial<TargetResult> = {}): TargetResult {
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

function snapshot(results: TargetResult[]): RunSnapshot {
  return {
    schemaVersion: 1,
    scannedAt: '2026-09-07T06:04:11.000Z',
    toolVersion: '1.0.0',
    rulesetSize: 18,
    results,
  };
}

/** A snapshot built from deliberately malformed data, as JSON text. */
function rawText(results: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    scannedAt: '2026-09-07T06:04:11.000Z',
    toolVersion: '1.0.0',
    rulesetSize: 18,
    results,
    ...over,
  });
}

describe('parseRunSnapshot — shape', () => {
  it('accepts a well-formed snapshot', () => {
    const parsed = parseRunSnapshot(JSON.stringify(snapshot([goodResult()])));
    expect(parsed.results).toHaveLength(1);
  });

  it('rejects a snapshot from a future schema', () => {
    expect(() => parseRunSnapshot(rawText([goodResult()], { schemaVersion: 2 }))).toThrow(
      /schemaVersion/,
    );
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseRunSnapshot('not json')).toThrow(/JSON/);
  });

  it('rejects a result missing a required field', () => {
    const broken: Record<string, unknown> = { ...goodResult() };
    delete broken['errorCount'];
    expect(() => parseRunSnapshot(rawText([broken]))).toThrow(/errorCount/);
  });

  it('rejects a result that is not an object, with a readable message', () => {
    // `field in null` throws a TypeError from inside the validator otherwise.
    for (const entry of [null, 'oops', 7]) {
      expect(() => parseRunSnapshot(rawText([entry]))).toThrow(/must be an object/);
    }
  });

  it('rejects duplicate result ids', () => {
    expect(() => parseRunSnapshot(rawText([goodResult(), goodResult()]))).toThrow(
      /duplicate/i,
    );
  });
});

describe('parseRunSnapshot — field types', () => {
  it('rejects a count that arrived as a string', () => {
    // Unvalidated, "3" + "1" concatenates to "031" in the published JSON.
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ sdkErrors: '3' as never })])),
    ).toThrow(/sdkErrors/);
  });

  it('rejects a negative or fractional count', () => {
    expect(() => parseRunSnapshot(rawText([goodResult({ errorCount: -1 })]))).toThrow(
      /errorCount/,
    );
    expect(() => parseRunSnapshot(rawText([goodResult({ warningCount: 1.5 })]))).toThrow(
      /warningCount/,
    );
  });

  it('rejects a non-boolean ready', () => {
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ ready: 'yes' as never })])),
    ).toThrow(/ready/);
  });

  it('rejects failedRules that is not an array of strings', () => {
    // "MCP001" iterates as characters, producing rule ids like "M" and "P".
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ failedRules: 'MCP001' as never })])),
    ).toThrow(/failedRules/);
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ failedRules: [1] as never })])),
    ).toThrow(/failedRules/);
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ failedRules: null as never })])),
    ).toThrow(/failedRules/);
  });

  it('rejects an unreachable that is neither null nor a non-empty reason', () => {
    // "" is falsy, so it would count as measured while carrying no numbers.
    expect(() => parseRunSnapshot(rawText([goodResult({ unreachable: '' })]))).toThrow(
      /unreachable/,
    );
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ unreachable: false as never })])),
    ).toThrow(/unreachable/);
  });

  it('rejects a transport outside the known set', () => {
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ transport: 'ws' as never })])),
    ).toThrow(/transport/);
  });

  it('rejects a scannedAt that is not an ISO timestamp', () => {
    // date is derived by slicing this, so "null" would become the row's date.
    for (const scannedAt of [null, 'yesterday', '2026-09-07']) {
      expect(() => parseRunSnapshot(rawText([goodResult()], { scannedAt }))).toThrow(
        /scannedAt/,
      );
    }
  });

  it('rejects a non-positive rulesetSize or an empty toolVersion', () => {
    expect(() => parseRunSnapshot(rawText([goodResult()], { rulesetSize: 0 }))).toThrow(
      /rulesetSize/,
    );
    expect(() => parseRunSnapshot(rawText([goodResult()], { toolVersion: '' }))).toThrow(
      /toolVersion/,
    );
  });
});

describe('parseRunSnapshot — evidence must never reach the index', () => {
  it('rejects a result carrying evidence at the top level', () => {
    const withEvidence = { ...goodResult(), evidence: [{ request: {} }] };
    expect(() => parseRunSnapshot(rawText([withEvidence]))).toThrow(/evidence/);
  });

  it('rejects a result spread from a full RunReport, where evidence is nested', () => {
    // The exact careless change a guard is supposed to catch: spreading the
    // report into the result carries findings[].evidence[].requestHeaders,
    // which can hold an Authorization header, plus stderr diagnostics.
    const leaky = {
      ...goodResult(),
      findings: [
        {
          ruleId: 'MCP001',
          evidence: [{ requestHeaders: { authorization: 'Bearer SECRET' } }],
        },
      ],
      diagnostics: ['[stderr] TOKEN=ghp_example'],
    };
    expect(() => parseRunSnapshot(rawText([leaky]))).toThrow(/findings|unexpected/);
  });

  it('rejects unexpected keys at the root of the snapshot', () => {
    expect(() =>
      parseRunSnapshot(rawText([goodResult()], { outcomes: [{ crashed: 'boom' }] })),
    ).toThrow(/outcomes|unexpected/);
  });
});

describe('summarise', () => {
  it('derives the date from scannedAt', () => {
    expect(summarise(snapshot([goodResult()])).date).toBe('2026-09-07');
  });

  it('counts ready, measured and unreachable separately', () => {
    const row = summarise(
      snapshot([
        goodResult({
          id: 'a',
          ready: true,
          errorCount: 0,
          sdkErrors: 0,
          applicationErrors: 0,
          failedRules: [],
        }),
        goodResult({ id: 'b' }),
        goodResult({ id: 'c', unreachable: 'install failed' }),
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
        goodResult({ id: 'a', errorCount: 4, sdkErrors: 3, applicationErrors: 1 }),
        goodResult({
          id: 'b',
          unreachable: 'never answered',
          errorCount: 0,
          sdkErrors: 0,
          applicationErrors: 0,
          failedRules: ['MCP002'],
        }),
      ]),
    );
    expect(row.sdkErrors).toBe(3);
    expect(row.applicationErrors).toBe(1);
    expect(row.ruleFailureCounts).toEqual({ MCP001: 1, MCP004: 1 });
  });

  it('handles an empty cohort without inventing numbers', () => {
    const row = summarise(snapshot([]));
    expect(row.cohortSize).toBe(0);
    expect(row.measured).toBe(0);
    expect(row.medianErrors).toBeNull();
    expect(row.ruleFailureCounts).toEqual({});
  });

  it('reports a null median when nothing was measurable', () => {
    const row = summarise(snapshot([goodResult({ unreachable: 'install failed' })]));
    expect(row.measured).toBe(0);
    expect(row.medianErrors).toBeNull();
  });

  it('takes the middle value for an odd cohort, unsorted input included', () => {
    const row = summarise(
      snapshot([
        goodResult({ id: 'a', errorCount: 9 }),
        goodResult({ id: 'b', errorCount: 2 }),
        goodResult({ id: 'c', errorCount: 10 }),
      ]),
    );
    // Numeric sort, not lexicographic: 2, 9, 10 → 9.
    expect(row.medianErrors).toBe(9);
  });

  it('takes the only value for a single-target cohort', () => {
    expect(summarise(snapshot([goodResult({ errorCount: 7 })])).medianErrors).toBe(7);
  });

  it('averages the two middle values for an even cohort', () => {
    const row = summarise(
      snapshot([
        goodResult({ id: 'a', errorCount: 2 }),
        goodResult({ id: 'b', errorCount: 4 }),
        goodResult({ id: 'c', errorCount: 5 }),
        goodResult({ id: 'd', errorCount: 9 }),
      ]),
    );
    expect(row.medianErrors).toBe(4.5);
  });

  it('carries toolVersion and rulesetSize so a trend cannot silently redefine itself', () => {
    const before = summarise(snapshot([goodResult()]));
    const after = summarise({
      ...snapshot([goodResult()]),
      toolVersion: '1.1.0',
      rulesetSize: 20,
    });
    // Two rows measured against different rulesets are distinguishable, which
    // is what lets the chart mark the change instead of hiding it.
    expect([before.rulesetSize, after.rulesetSize]).toEqual([18, 20]);
    expect([before.toolVersion, after.toolVersion]).toEqual(['1.0.0', '1.1.0']);
  });

  it('sorts ruleFailureCounts by rule id', () => {
    const row = summarise(
      snapshot([goodResult({ failedRules: ['MCP012', 'MCP002', 'MCP001'] })]),
    );
    expect(Object.keys(row.ruleFailureCounts)).toEqual(['MCP001', 'MCP002', 'MCP012']);
  });

  it('counts a rule id that collides with Object.prototype without corruption', () => {
    // A plain-object accumulator turns "__proto__" into a silent no-op and
    // "constructor" into a stringified function.
    const row = summarise(
      snapshot([
        goodResult({ id: 'a', failedRules: ['__proto__', 'constructor'] }),
        goodResult({ id: 'b', failedRules: ['__proto__'] }),
      ]),
    );
    expect(row.ruleFailureCounts['__proto__']).toBe(2);
    expect(row.ruleFailureCounts['constructor']).toBe(1);
    expect(JSON.parse(JSON.stringify(row)).ruleFailureCounts['__proto__']).toBe(2);
  });
});
