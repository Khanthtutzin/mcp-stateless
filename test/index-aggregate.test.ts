import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applySnapshot,
  parseHistory,
  parseRunSnapshot,
  summarise,
  upsertRow,
  type HistoryRow,
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

// --- Task 2: history file ---------------------------------------------------

function row(date: string, over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    date,
    toolVersion: '1.0.0',
    rulesetSize: 18,
    cohortSize: 2,
    measured: 2,
    unreachable: 0,
    ready: 0,
    medianErrors: 4,
    sdkErrors: 6,
    applicationErrors: 2,
    ruleFailureCounts: { MCP001: 2 },
    ...over,
  };
}

function historyText(rows: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, rows, ...over });
}

describe('parseHistory', () => {
  it('accepts the seeded empty history', () => {
    expect(parseHistory('{"schemaVersion":1,"rows":[]}').rows).toEqual([]);
  });

  it('rejects a history from a future schema', () => {
    expect(() => parseHistory(historyText([], { schemaVersion: 2 }))).toThrow(
      /schemaVersion/,
    );
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseHistory('nope')).toThrow(/JSON/);
  });

  it('rejects rows that is not an array', () => {
    expect(() => parseHistory('{"schemaVersion":1,"rows":{}}')).toThrow(/rows/);
  });

  it('rejects a row carrying an unexpected key', () => {
    // history.json is committed and read by the site; a stray key means
    // something wrote a shape the renderer does not know about.
    const stray = { ...row('2026-09-07'), findings: [{ evidence: [] }] };
    expect(() => parseHistory(historyText([stray]))).toThrow(/findings|unexpected/);
  });

  it('rejects a row with a malformed date', () => {
    for (const date of ['2026-9-7', 'yesterday', '2026-09-07T06:00:00Z']) {
      expect(() => parseHistory(historyText([row(date)]))).toThrow(/date/);
    }
  });

  it('rejects a row with a non-integer count', () => {
    expect(() => parseHistory(historyText([row('2026-09-07', { ready: 1.5 })]))).toThrow(
      /ready/,
    );
    expect(() =>
      parseHistory(historyText([row('2026-09-07', { sdkErrors: '6' as never })])),
    ).toThrow(/sdkErrors/);
  });

  it('rejects a medianErrors that is neither null nor a number', () => {
    expect(() =>
      parseHistory(historyText([row('2026-09-07', { medianErrors: '4' as never })])),
    ).toThrow(/medianErrors/);
  });

  it('accepts a fractional medianErrors, which an even cohort produces', () => {
    expect(
      parseHistory(historyText([row('2026-09-07', { medianErrors: 4.5 })])).rows[0]!
        .medianErrors,
    ).toBe(4.5);
  });

  it('rejects a row whose counts do not add up', () => {
    // measured + unreachable must equal the cohort, and ready cannot exceed
    // what was measured — otherwise the site renders percentages over 100%.
    expect(() =>
      parseHistory(historyText([row('2026-09-07', { measured: 1, unreachable: 0 })])),
    ).toThrow(/cohortSize|add up/);
    expect(() => parseHistory(historyText([row('2026-09-07', { ready: 3 })]))).toThrow(
      /ready/,
    );
  });

  it('rejects duplicate dates', () => {
    expect(() =>
      parseHistory(historyText([row('2026-09-07'), row('2026-09-07')])),
    ).toThrow(/duplicate/i);
  });
});

describe('upsertRow', () => {
  it('appends a new date', () => {
    const history = upsertRow(
      { schemaVersion: 1, rows: [row('2026-09-07')] },
      row('2026-09-14'),
    );
    expect(history.rows.map((r) => r.date)).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('replaces a row for a date already present', () => {
    // Re-running a scan for the same day corrects that day; it never appends a
    // second row, which would double-count the cohort in the trend.
    const history = upsertRow(
      { schemaVersion: 1, rows: [row('2026-09-07', { ready: 0 })] },
      row('2026-09-07', { ready: 2 }),
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.ready).toBe(2);
  });

  it('keeps rows sorted by date', () => {
    const history = upsertRow(
      { schemaVersion: 1, rows: [row('2026-09-14')] },
      row('2026-09-07'),
    );
    expect(history.rows.map((r) => r.date)).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('does not mutate the history it was given', () => {
    const original = { schemaVersion: 1 as const, rows: [row('2026-09-07')] };
    upsertRow(original, row('2026-09-14'));
    expect(original.rows).toHaveLength(1);
  });
});

describe('applySnapshot', () => {
  const snapshotText = (results: TargetResult[]) =>
    JSON.stringify({
      schemaVersion: 1,
      scannedAt: '2026-09-07T06:04:11.000Z',
      toolVersion: '1.0.0',
      rulesetSize: 18,
      results,
    });

  it('adds the summarised row to the history', () => {
    const { history, row: added } = applySnapshot(
      snapshotText([goodResult()]),
      '{"schemaVersion":1,"rows":[]}',
    );
    expect(added.date).toBe('2026-09-07');
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.measured).toBe(1);
  });

  it('is idempotent when the same snapshot is applied twice', () => {
    const first = applySnapshot(
      snapshotText([goodResult()]),
      '{"schemaVersion":1,"rows":[]}',
    );
    const second = applySnapshot(
      snapshotText([goodResult()]),
      JSON.stringify(first.history),
    );
    expect(second.history.rows).toHaveLength(1);
  });

  it('refuses to record a run in which nothing was measurable', () => {
    // A row of zeroes would be a false datum, not a measurement.
    expect(() =>
      applySnapshot(
        snapshotText([goodResult({ unreachable: 'install failed' })]),
        '{"schemaVersion":1,"rows":[]}',
      ),
    ).toThrow(/measurable/);
  });
});

// --- The CLI entry, spawned as a real process -------------------------------

describe('aggregate-index CLI', () => {
  const script = fileURLToPath(
    new URL('../scripts/aggregate-index.mjs', import.meta.url),
  );

  function run(args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  }

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-index-cli-'));
    writeFileSync(join(dir, 'history.json'), '{"schemaVersion":1,"rows":[]}');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeSnapshot(name: string, results: TargetResult[]) {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        scannedAt: '2026-09-07T06:00:00.000Z',
        toolVersion: '0.1.5',
        rulesetSize: 18,
        results,
      }),
    );
    return path;
  }

  it('appends a row and exits 0', () => {
    const snapshot = writeSnapshot('snap.json', [goodResult()]);
    const result = run(['--snapshot', snapshot, '--history', join(dir, 'history.json')]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2026-09-07');
    const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
    expect(history.rows).toHaveLength(1);
  });

  it('replaces rather than appends when run twice for the same date', () => {
    const snapshot = writeSnapshot('snap.json', [goodResult()]);
    const args = ['--snapshot', snapshot, '--history', join(dir, 'history.json')];
    run(args);
    run(args);

    const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
    expect(history.rows).toHaveLength(1);
  });

  it('exits 1 and leaves the history untouched when nothing was measurable', () => {
    const snapshot = writeSnapshot('dead.json', [
      goodResult({
        unreachable: 'install failed',
        errorCount: 0,
        warningCount: 0,
        sdkErrors: 0,
        applicationErrors: 0,
        failedRules: [],
      }),
    ]);
    const result = run(['--snapshot', snapshot, '--history', join(dir, 'history.json')]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/measurable/);
    const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));
    expect(history.rows).toEqual([]);
  });

  it('exits 2 when --snapshot is missing', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--snapshot');
  });
});

describe('aggregate-index CLI — --runs-dir places the snapshot itself', () => {
  // The weekly workflow's committing job holds `contents: write` and must
  // never execute target code or interpolate anything from a snapshot into a
  // shell command. Deriving the filename in the shell —
  // `date="$(node -p 'require("./s.json").scannedAt.slice(0,10)')"` — puts an
  // unvalidated field inside a double-quoted string, where `$( )` still
  // expands. Doing it here means the path is built only from a value that has
  // already been through parseRunSnapshot.
  const script = fileURLToPath(
    new URL('../scripts/aggregate-index.mjs', import.meta.url),
  );

  function run(args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  }

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-index-runsdir-'));
    writeFileSync(join(dir, 'history.json'), '{"schemaVersion":1,"rows":[]}');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function snapshotFile(over: Record<string, unknown> = {}) {
    const path = join(dir, 'snapshot.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        scannedAt: '2026-09-07T06:00:00.000Z',
        toolVersion: '0.1.5',
        rulesetSize: 18,
        results: [goodResult()],
        ...over,
      }),
    );
    return path;
  }

  it('writes the snapshot under the run directory, named by its date', () => {
    const runs = join(dir, 'runs');
    const result = run([
      '--snapshot',
      snapshotFile(),
      '--history',
      join(dir, 'history.json'),
      '--runs-dir',
      runs,
    ]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const placed = JSON.parse(readFileSync(join(runs, '2026-09-07.json'), 'utf8'));
    expect(placed.scannedAt).toBe('2026-09-07T06:00:00.000Z');
    expect(result.stdout).toContain('2026-09-07.json');
  });

  it('creates the run directory when it does not exist', () => {
    const runs = join(dir, 'a', 'b', 'runs');
    const result = run([
      '--snapshot',
      snapshotFile(),
      '--history',
      join(dir, 'history.json'),
      '--runs-dir',
      runs,
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(join(runs, '2026-09-07.json'))).toBe(true);
  });

  it('places nothing when the snapshot does not validate', () => {
    // Validation first, then the write. The other order would commit a file
    // the aggregator had already refused.
    const runs = join(dir, 'runs');
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({
        schemaVersion: 1,
        scannedAt: '2026-09-07T06:00:00.000Z',
        toolVersion: '0.1.5',
        rulesetSize: 18,
        results: [{ ...goodResult(), authorization: 'Bearer SECRET' }],
      }),
    );

    const result = run([
      '--snapshot',
      bad,
      '--history',
      join(dir, 'history.json'),
      '--runs-dir',
      runs,
    ]);

    expect(result.status).toBe(1);
    expect(existsSync(join(runs, '2026-09-07.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')).rows).toEqual([]);
  });

  it('places nothing when nothing was measurable', () => {
    const runs = join(dir, 'runs');
    const result = run([
      '--snapshot',
      snapshotFile({
        results: [
          goodResult({
            unreachable: 'install failed',
            errorCount: 0,
            warningCount: 0,
            sdkErrors: 0,
            applicationErrors: 0,
            failedRules: [],
          }),
        ],
      }),
      '--history',
      join(dir, 'history.json'),
      '--runs-dir',
      runs,
    ]);

    expect(result.status).toBe(1);
    expect(existsSync(join(runs, '2026-09-07.json'))).toBe(false);
  });

  it('refuses a run directory that is not a plain path', () => {
    for (const runs of ['', '   ']) {
      const result = run([
        '--snapshot',
        snapshotFile(),
        '--history',
        join(dir, 'history.json'),
        '--runs-dir',
        runs,
      ]);
      expect(result.status).not.toBe(0);
    }
  });

  it('leaves the run directory alone when --runs-dir is not given', () => {
    const result = run([
      '--snapshot',
      snapshotFile(),
      '--history',
      join(dir, 'history.json'),
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });
});

// --- Hardening from the Task 2 review ---------------------------------------

describe('the allow-list is an allow-list, not a blacklist', () => {
  // These use stray keys that are NOT on the evidence list. A blacklist would
  // accept them, so these are the tests that can tell the two apart — the
  // earlier ones all used keys that appeared on both lists.
  it('rejects a snapshot key that is merely unknown', () => {
    expect(() =>
      parseRunSnapshot(rawText([goodResult()], { generatedAt: 'now' })),
    ).toThrow(/unexpected key/);
  });

  it('rejects a result key that is merely unknown', () => {
    const odd = { ...goodResult(), percentReady: 50 };
    expect(() => parseRunSnapshot(rawText([odd]))).toThrow(/unexpected key/);
  });

  it('rejects a history key that is merely unknown', () => {
    expect(() => parseHistory(historyText([], { generatedAt: 'now' }))).toThrow(
      /unexpected key/,
    );
  });

  it('rejects a history row key that is merely unknown', () => {
    const odd = { ...row('2026-09-07'), notes: 'looks fine' };
    expect(() => parseHistory(historyText([odd]))).toThrow(/unexpected key/);
  });
});

describe('rule ids are validated, not merely non-empty', () => {
  it('rejects a failedRules entry that is not a rule id', () => {
    expect(() =>
      parseRunSnapshot(rawText([goodResult({ failedRules: ['not-a-rule'] })])),
    ).toThrow(/failedRules/);
  });

  it('rejects a ruleFailureCounts key that is not a rule id', () => {
    // This label is rendered on the page as "most common blocker".
    const bad = row('2026-09-07', {
      ruleFailureCounts: { '<script>alert(1)</script>': 1 },
    });
    expect(() => parseHistory(historyText([bad]))).toThrow(/ruleFailureCounts/);
  });
});

describe('history rows cannot render impossible numbers', () => {
  it('rejects a rule count larger than the number of servers measured', () => {
    // 500 failures out of 2 measured renders 25000% on the chart.
    const bad = row('2026-09-07', { ruleFailureCounts: { MCP001: 500 } });
    expect(() => parseHistory(historyText([bad]))).toThrow(/MCP001|measured/);
  });

  it('rejects an all-zero row, which would render NaN%', () => {
    const empty = row('2026-09-07', {
      cohortSize: 0,
      measured: 0,
      unreachable: 0,
      ready: 0,
      // 0 rather than null, so this isolates the measured===0 guard instead of
      // tripping the median one first.
      medianErrors: 0,
      sdkErrors: 0,
      applicationErrors: 0,
      ruleFailureCounts: {},
    });
    expect(() => parseHistory(historyText([empty]))).toThrow(/measur/);
  });

  it('rejects a negative or null medianErrors in a recorded row', () => {
    // summarise returns null only when nothing was measurable, and such a run
    // is never recorded — so a stored row always has a real median.
    expect(() =>
      parseHistory(historyText([row('2026-09-07', { medianErrors: -5 })])),
    ).toThrow(/medianErrors/);
    expect(() =>
      parseHistory(historyText([row('2026-09-07', { medianErrors: null })])),
    ).toThrow(/medianErrors/);
  });

  it('rejects a date that does not exist on a calendar', () => {
    // new Date("2026-02-30") silently becomes 2 March, shifting a chart point.
    for (const date of ['2026-02-30', '2026-13-45', '0000-00-00']) {
      expect(() => parseHistory(historyText([row(date)]))).toThrow(/date/);
    }
  });

  it('rejects rows that are not in ascending date order', () => {
    // The site renders in array order, so a descending file draws the trend
    // backwards.
    expect(() =>
      parseHistory(historyText([row('2026-09-14'), row('2026-09-07')])),
    ).toThrow(/order/);
  });
});

describe('upsertRow really does leave its input alone', () => {
  it('does not share row objects with the history it was given', () => {
    const original = { schemaVersion: 1 as const, rows: [row('2026-09-07')] };
    const next = upsertRow(original, row('2026-09-14'));

    next.rows[0]!.ready = 99;
    next.rows[0]!.ruleFailureCounts['MCP001'] = 999;

    expect(original.rows[0]!.ready).toBe(0);
    expect(original.rows[0]!.ruleFailureCounts['MCP001']).toBe(2);
  });

  it('does not alias the row it returns with the one it stored', () => {
    const { history, row: added } = applySnapshot(
      JSON.stringify({
        schemaVersion: 1,
        scannedAt: '2026-09-07T06:04:11.000Z',
        toolVersion: '1.0.0',
        rulesetSize: 18,
        results: [goodResult()],
      }),
      '{"schemaVersion":1,"rows":[]}',
    );
    added.ready = 42;
    expect(history.rows[0]!.ready).not.toBe(42);
  });
});

describe('applySnapshot reports the right file first', () => {
  it('names the corrupt history even when nothing was measurable', () => {
    // Otherwise the operator investigates the scanner and never learns the
    // committed file is unparseable.
    const dead = JSON.stringify({
      schemaVersion: 1,
      scannedAt: '2026-09-07T06:04:11.000Z',
      toolVersion: '1.0.0',
      rulesetSize: 18,
      results: [
        goodResult({
          unreachable: 'install failed',
          errorCount: 0,
          warningCount: 0,
          sdkErrors: 0,
          applicationErrors: 0,
          failedRules: [],
        }),
      ],
    });
    expect(() => applySnapshot(dead, 'not json at all')).toThrow(/History/);
  });
});
