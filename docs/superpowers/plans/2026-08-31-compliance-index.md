# Compliance Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a weekly, reproducible measurement of how much of the MCP server ecosystem has migrated to `2026-07-28`, rendered on the existing static site, with no backend.

**Architecture:** A curated, version-pinned cohort in `index/targets.json` is probed by a zero-dependency Node script that consumes `runChecks` the same way users do. Each run writes a dated snapshot of verdicts; a pure `summarise()` reduces that snapshot to one row appended to `index/history.json`, whose git history is the audit trail. A two-job GitHub Actions workflow separates executing third-party code (no credentials) from committing results (no third-party code).

**Tech Stack:** Node ≥ 20 ESM, plain `.mjs` scripts with hand-written `.d.mts` types, Vitest 3, GitHub Actions, and the existing React/Vite site.

## Global Constraints

- **Zero runtime dependencies.** The root `package.json` `dependencies` field stays empty. Scripts use only `node:` built-ins and the project's own `dist/`.
- **Node ≥ 20**, ESM only (`"type": "module"`). No CommonJS.
- **Exact versions only** for `npm` targets: `^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`. Ranges are rejected, not warned about.
- **`--ignore-scripts` on every install.** No exceptions.
- **stdio targets only.** No HTTP target is added without its operator's explicit consent.
- **Verdicts only, never evidence.** Snapshots store counts and rule ids. Never `Exchange` data, never request/response bodies, never headers.
- **Every gate must pass before each commit:** `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`, `npm test`.
- **Prettier owns formatting.** Run `npx prettier --write <files>` before committing; `format:check` is enforced in CI.
- **Task 7 touches `site/`, which a concurrent effort also owns.** Do not start Task 7 without confirming the website work is paused or merged. Tasks 1–6 touch no site files.

---

## File Structure

| File                                   | Responsibility                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `index/targets.json`                   | Cohort definition. Curated, version-pinned. Reviewed by PR.                              |
| `index/history.json`                   | Append-only aggregate rows, one per run. Seeded empty.                                   |
| `index/runs/<date>.json`               | Per-run snapshot of verdicts. Written by the scanner.                                    |
| `scripts/aggregate-index.mjs`          | **Pure:** `parseRunSnapshot`, `summarise`, `upsertRow`. Plus a CLI entry.                |
| `scripts/aggregate-index.d.mts`        | Hand-written types so TS tests can import the above.                                     |
| `scripts/scan-index.mjs`               | **I/O:** `loadTargets`, `resolveNpmBin`, `createProbe`, `scanTargets`. Plus a CLI entry. |
| `scripts/scan-index.d.mts`             | Hand-written types for the scanner's exports.                                            |
| `test/index-aggregate.test.ts`         | Unit tests for the pure aggregation module.                                              |
| `test/index-scan.test.ts`              | Unit + offline integration tests for the scanner.                                        |
| `test/fixtures/fake-package/`          | A fake installed package, for `resolveNpmBin` tests.                                     |
| `.github/workflows/index.yml`          | Weekly two-job workflow: `scan` (no token) → `commit` (no third-party code).             |
| `site/src/components/IndexSection.tsx` | Headline, inline-SVG trend, cohort table. **Task 7 only.**                               |

Why the split: `aggregate-index.mjs` is pure and therefore cheap to test exhaustively; `scan-index.mjs` owns every side effect. This mirrors the existing rules/transport boundary — the thing worth testing does not touch the thing that touches the world.

---

### Task 1: Pure aggregation — parse and summarise

**Files:**

- Create: `scripts/aggregate-index.mjs`
- Create: `scripts/aggregate-index.d.mts`
- Test: `test/index-aggregate.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `parseRunSnapshot(text: string): RunSnapshot` — throws `Error` on malformed input.
  - `summarise(snapshot: RunSnapshot): HistoryRow`
  - Types `RunSnapshot`, `TargetResult`, `HistoryRow` as declared in `aggregate-index.d.mts`.

- [ ] **Step 1: Write the failing test**

Create `test/index-aggregate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { parseRunSnapshot, summarise } from '../scripts/aggregate-index.mjs';

/** A snapshot with the given results and sane defaults elsewhere. */
function snapshot(results: unknown[]) {
  return {
    schemaVersion: 1,
    scannedAt: '2026-09-07T06:04:11.000Z',
    toolVersion: '1.0.0',
    rulesetSize: 18,
    results,
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/index-aggregate.test.ts`
Expected: FAIL — `Failed to resolve import "../scripts/aggregate-index.mjs"`.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/aggregate-index.mjs`:

```javascript
/**
 * Aggregate one compliance-index run into a single history row.
 *
 * Everything here is pure: no file reads, no network, no clock. That is what
 * makes the numbers on the site testable, and it mirrors the rules/transport
 * split in src/ — the thing worth testing does not touch the world.
 */

/** Fields every result must carry. A missing one is a bug in the scanner. */
const REQUIRED_RESULT_FIELDS = [
  'id',
  'package',
  'version',
  'transport',
  'ready',
  'errorCount',
  'warningCount',
  'sdkErrors',
  'applicationErrors',
  'failedRules',
  'unreachable',
];

/**
 * Fields that must NOT appear. The index stores verdicts, never evidence;
 * refusing them here means a future careless change fails a test rather than
 * quietly publishing someone else's wire traffic.
 */
const FORBIDDEN_RESULT_FIELDS = ['evidence', 'transcript', 'requestHeaders'];

export function parseRunSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Snapshot is not valid JSON: ${err.message}`);
  }

  if (raw?.schemaVersion !== 1) {
    throw new Error(
      `Unsupported snapshot schemaVersion ${JSON.stringify(raw?.schemaVersion)}; expected 1.`,
    );
  }
  for (const field of ['scannedAt', 'toolVersion', 'rulesetSize']) {
    if (raw[field] === undefined) throw new Error(`Snapshot is missing ${field}.`);
  }
  if (!Array.isArray(raw.results)) {
    throw new Error('Snapshot results must be an array.');
  }

  for (const result of raw.results) {
    for (const field of REQUIRED_RESULT_FIELDS) {
      if (!(field in result)) {
        throw new Error(
          `Result ${JSON.stringify(result.id ?? '?')} is missing ${field}.`,
        );
      }
    }
    for (const field of FORBIDDEN_RESULT_FIELDS) {
      if (field in result) {
        throw new Error(
          `Result ${JSON.stringify(result.id)} carries ${field}. The index stores verdicts, never evidence.`,
        );
      }
    }
  }

  return raw;
}

/** Median of a numeric array, or null when there is nothing to measure. */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarise(snapshot) {
  const results = snapshot.results;
  // Unreachable targets are excluded from every total. A server that would not
  // start is "not measurable", never "failing" — the same principle as the
  // CLI's refusal to turn a launch failure into eighteen verdicts.
  const measured = results.filter((r) => !r.unreachable);

  const ruleFailureCounts = {};
  for (const r of measured) {
    for (const id of r.failedRules) {
      ruleFailureCounts[id] = (ruleFailureCounts[id] ?? 0) + 1;
    }
  }
  const sortedCounts = {};
  for (const id of Object.keys(ruleFailureCounts).sort()) {
    sortedCounts[id] = ruleFailureCounts[id];
  }

  return {
    date: String(snapshot.scannedAt).slice(0, 10),
    toolVersion: snapshot.toolVersion,
    rulesetSize: snapshot.rulesetSize,
    cohortSize: results.length,
    measured: measured.length,
    unreachable: results.length - measured.length,
    ready: measured.filter((r) => r.ready).length,
    medianErrors: median(measured.map((r) => r.errorCount)),
    sdkErrors: measured.reduce((n, r) => n + r.sdkErrors, 0),
    applicationErrors: measured.reduce((n, r) => n + r.applicationErrors, 0),
    ruleFailureCounts: sortedCounts,
  };
}
```

Create `scripts/aggregate-index.d.mts`:

```typescript
/**
 * Types for scripts/aggregate-index.mjs.
 *
 * Hand-written, following the convention already used by
 * test/fixtures/servers/http-server.d.mts: the script stays plain JavaScript
 * so it never ships inside the published package, while TS tests still get
 * real types.
 */

export interface TargetResult {
  id: string;
  package: string;
  version: string;
  transport: 'stdio' | 'http';
  ready: boolean;
  errorCount: number;
  warningCount: number;
  sdkErrors: number;
  applicationErrors: number;
  failedRules: string[];
  /** A reason string when the target could not be measured, else null. */
  unreachable: string | null;
}

export interface RunSnapshot {
  schemaVersion: 1;
  scannedAt: string;
  toolVersion: string;
  rulesetSize: number;
  results: TargetResult[];
}

export interface HistoryRow {
  date: string;
  toolVersion: string;
  rulesetSize: number;
  cohortSize: number;
  measured: number;
  unreachable: number;
  ready: number;
  /** Null when nothing was measurable. */
  medianErrors: number | null;
  sdkErrors: number;
  applicationErrors: number;
  ruleFailureCounts: Record<string, number>;
}

export function parseRunSnapshot(text: string): RunSnapshot;
export function summarise(snapshot: RunSnapshot): HistoryRow;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/index-aggregate.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. If `lint` complains that `scripts/` is not covered by the ESLint config, add `scripts/**/*.mjs` to the existing `files` globs in `eslint.config.js` rather than disabling the rule.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/aggregate-index.mjs scripts/aggregate-index.d.mts test/index-aggregate.test.ts
git add scripts/aggregate-index.mjs scripts/aggregate-index.d.mts test/index-aggregate.test.ts
git commit -m "feat(index): pure snapshot parsing and aggregation"
```

---

### Task 2: History file and the aggregate CLI entry

**Files:**

- Create: `index/history.json`
- Modify: `scripts/aggregate-index.mjs` (append `upsertRow` and a CLI entry)
- Modify: `scripts/aggregate-index.d.mts`
- Modify: `test/index-aggregate.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**

- Consumes: `parseRunSnapshot`, `summarise` from Task 1.
- Produces:
  - `upsertRow(history: History, row: HistoryRow): History` — replaces any row with the same `date`, then sorts by date ascending.
  - `parseHistory(text: string): History`
  - CLI: `node scripts/aggregate-index.mjs --snapshot <file> --history <file>`

- [ ] **Step 1: Write the failing test**

Append to `test/index-aggregate.test.ts`:

```typescript
import { parseHistory, upsertRow } from '../scripts/aggregate-index.mjs';

describe('upsertRow', () => {
  const row = (date: string, ready = 0) => ({
    date,
    toolVersion: '1.0.0',
    rulesetSize: 18,
    cohortSize: 1,
    measured: 1,
    unreachable: 0,
    ready,
    medianErrors: 0,
    sdkErrors: 0,
    applicationErrors: 0,
    ruleFailureCounts: {},
  });

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
      { schemaVersion: 1, rows: [row('2026-09-07', 0)] },
      row('2026-09-07', 3),
    );
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]!.ready).toBe(3);
  });

  it('keeps rows sorted by date', () => {
    const history = upsertRow(
      { schemaVersion: 1, rows: [row('2026-09-14')] },
      row('2026-09-07'),
    );
    expect(history.rows.map((r) => r.date)).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('rejects a history from a future schema', () => {
    expect(() => parseHistory('{"schemaVersion":2,"rows":[]}')).toThrow(/schemaVersion/);
  });

  it('accepts the seeded empty history', () => {
    expect(parseHistory('{"schemaVersion":1,"rows":[]}').rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/index-aggregate.test.ts`
Expected: FAIL — `upsertRow is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `scripts/aggregate-index.mjs`:

```javascript
export function parseHistory(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`History is not valid JSON: ${err.message}`);
  }
  if (raw?.schemaVersion !== 1) {
    throw new Error(
      `Unsupported history schemaVersion ${JSON.stringify(raw?.schemaVersion)}; expected 1.`,
    );
  }
  if (!Array.isArray(raw.rows)) throw new Error('History rows must be an array.');
  return raw;
}

export function upsertRow(history, row) {
  const rows = history.rows.filter((existing) => existing.date !== row.date);
  rows.push(row);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { ...history, rows };
}
```

Then add the CLI entry at the end of the same file:

```javascript
// --- CLI -------------------------------------------------------------------

/**
 * Only the CLI entry touches the filesystem. Keeping it below the exports, and
 * behind a direct-invocation check, is what lets tests import the pure half.
 */
async function cli(argv) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { parseArgs } = await import('node:util');

  const { values } = parseArgs({
    args: argv,
    options: {
      snapshot: { type: 'string' },
      history: { type: 'string', default: 'index/history.json' },
    },
  });

  if (!values.snapshot) {
    process.stderr.write(
      'Usage: node scripts/aggregate-index.mjs --snapshot <file> [--history <file>]\n',
    );
    return 2;
  }

  const snapshot = parseRunSnapshot(readFileSync(values.snapshot, 'utf8'));
  const row = summarise(snapshot);

  // A row of zeroes would be a false datum, not a measurement.
  if (row.measured === 0) {
    process.stderr.write(
      'Nothing was measurable in this run; refusing to append a history row.\n',
    );
    return 1;
  }

  const history = parseHistory(readFileSync(values.history, 'utf8'));
  const updated = upsertRow(history, row);
  writeFileSync(values.history, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `${row.date}: ${row.ready}/${row.measured} ready (${row.unreachable} not measurable)\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`aggregate-index failed: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
```

Add to `scripts/aggregate-index.d.mts`:

```typescript
export interface History {
  schemaVersion: 1;
  rows: HistoryRow[];
}

export function parseHistory(text: string): History;
export function upsertRow(history: History, row: HistoryRow): History;
```

Create `index/history.json`:

```json
{
  "schemaVersion": 1,
  "rows": []
}
```

Add to `package.json` `scripts`, after `"docs:check"`:

```json
"index:aggregate": "node scripts/aggregate-index.mjs",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/index-aggregate.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Verify the CLI end to end by hand**

```bash
mkdir -p index/runs
cat > /tmp-check.json <<'JSON'
{"schemaVersion":1,"scannedAt":"2026-09-07T06:00:00.000Z","toolVersion":"0.1.5","rulesetSize":18,
 "results":[{"id":"a","package":"@example/a","version":"1.0.0","transport":"stdio","ready":false,
 "errorCount":4,"warningCount":1,"sdkErrors":3,"applicationErrors":1,
 "failedRules":["MCP001"],"unreachable":null}]}
JSON
node scripts/aggregate-index.mjs --snapshot /tmp-check.json
```

Expected: prints `2026-09-07: 0/1 ready (0 not measurable)`, and `index/history.json` gains one row.
Then revert the scratch data: `git checkout index/history.json && rm /tmp-check.json`.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/aggregate-index.mjs scripts/aggregate-index.d.mts test/index-aggregate.test.ts index/history.json package.json
git add scripts/aggregate-index.mjs scripts/aggregate-index.d.mts test/index-aggregate.test.ts index/history.json package.json
git commit -m "feat(index): append-only history with same-day upsert"
```

---

### Task 3: Cohort definition and target validation

**Files:**

- Create: `index/targets.json`
- Create: `scripts/scan-index.mjs` (validation only at this stage)
- Create: `scripts/scan-index.d.mts`
- Test: `test/index-scan.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `loadTargets(text: string, options?: { allowLocal?: boolean }): Target[]`
  - Types `Target`, `NpmTarget`, `LocalTarget`.

- [ ] **Step 1: Write the failing test**

Create `test/index-scan.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { loadTargets } from '../scripts/scan-index.mjs';

const npmTarget = {
  kind: 'npm',
  id: 'example-a',
  label: 'a',
  package: '@example/server-a',
  version: '1.2.3',
  bin: 'server-a',
  transport: 'stdio',
};

function file(targets: unknown[]) {
  return JSON.stringify({ schemaVersion: 1, targets });
}

describe('loadTargets', () => {
  it('accepts an exact-versioned npm target', () => {
    expect(loadTargets(file([npmTarget]))).toHaveLength(1);
  });

  it('accepts an exact prerelease version', () => {
    expect(loadTargets(file([{ ...npmTarget, version: '2.0.0-alpha.0' }]))).toHaveLength(
      1,
    );
  });

  it('rejects a caret range', () => {
    // A floating version would let an upstream release change both the numbers
    // and the executed code with no review.
    expect(() => loadTargets(file([{ ...npmTarget, version: '^1.2.3' }]))).toThrow(
      /exact version/,
    );
  });

  it('rejects "latest"', () => {
    expect(() => loadTargets(file([{ ...npmTarget, version: 'latest' }]))).toThrow(
      /exact version/,
    );
  });

  it('rejects duplicate ids', () => {
    expect(() => loadTargets(file([npmTarget, npmTarget]))).toThrow(/duplicate/i);
  });

  it('rejects an http target', () => {
    expect(() => loadTargets(file([{ ...npmTarget, transport: 'http' }]))).toThrow(
      /stdio/,
    );
  });

  it('rejects a local target by default', () => {
    const local = {
      kind: 'local',
      id: 'fixture',
      label: 'fixture',
      command: 'node x.mjs',
    };
    expect(() => loadTargets(file([local]))).toThrow(/--allow-local/);
  });

  it('accepts a local target when explicitly allowed', () => {
    const local = {
      kind: 'local',
      id: 'fixture',
      label: 'fixture',
      command: 'node x.mjs',
    };
    expect(loadTargets(file([local]), { allowLocal: true })).toHaveLength(1);
  });

  it('rejects an empty cohort', () => {
    expect(() => loadTargets(file([]))).toThrow(/at least one/);
  });

  it('rejects a targets file from a future schema', () => {
    expect(() => loadTargets('{"schemaVersion":2,"targets":[]}')).toThrow(
      /schemaVersion/,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/index-scan.test.ts`
Expected: FAIL — `Failed to resolve import "../scripts/scan-index.mjs"`.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/scan-index.mjs`:

```javascript
/**
 * Probe the curated compliance-index cohort.
 *
 * This module owns every side effect: installing packages, spawning servers,
 * writing snapshots. The aggregation it feeds is pure and lives in
 * scripts/aggregate-index.mjs.
 */

/** Exact semver only. No ranges, no tags. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function loadTargets(text, options = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Targets file is not valid JSON: ${err.message}`);
  }
  if (raw?.schemaVersion !== 1) {
    throw new Error(
      `Unsupported targets schemaVersion ${JSON.stringify(raw?.schemaVersion)}; expected 1.`,
    );
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error('Targets file must list at least one target.');
  }

  const seen = new Set();
  for (const target of raw.targets) {
    if (!target.id) throw new Error('Every target needs an id.');
    if (seen.has(target.id)) {
      throw new Error(`Duplicate target id ${JSON.stringify(target.id)}.`);
    }
    seen.add(target.id);

    if (target.kind === 'local') {
      if (!options.allowLocal) {
        throw new Error(
          `Target ${JSON.stringify(target.id)} is a local target. Pass --allow-local to scan it; the published cohort must not contain one.`,
        );
      }
      if (!target.command) {
        throw new Error(`Local target ${JSON.stringify(target.id)} needs a command.`);
      }
      continue;
    }

    if (target.kind !== 'npm') {
      throw new Error(
        `Target ${JSON.stringify(target.id)} has unknown kind ${JSON.stringify(target.kind)}.`,
      );
    }
    for (const field of ['package', 'version', 'bin']) {
      if (!target[field]) {
        throw new Error(`Target ${JSON.stringify(target.id)} needs ${field}.`);
      }
    }
    if (!EXACT_VERSION.test(target.version)) {
      throw new Error(
        `Target ${JSON.stringify(target.id)} must pin an exact version, got ${JSON.stringify(target.version)}.`,
      );
    }
    // The cohort is stdio-only: probing someone's hosted endpoint on a cron
    // without their consent is not something this project does.
    if (target.transport !== 'stdio') {
      throw new Error(
        `Target ${JSON.stringify(target.id)} must be stdio; hosted endpoints are only added with the operator's consent.`,
      );
    }
  }

  return raw.targets;
}
```

Create `scripts/scan-index.d.mts`:

```typescript
export interface NpmTarget {
  kind: 'npm';
  id: string;
  label: string;
  package: string;
  version: string;
  bin: string;
  transport: 'stdio';
  note?: string;
}

export interface LocalTarget {
  kind: 'local';
  id: string;
  label: string;
  command: string;
}

export type Target = NpmTarget | LocalTarget;

export function loadTargets(text: string, options?: { allowLocal?: boolean }): Target[];
```

Create `index/targets.json` — resolve each version first with
`npm view @modelcontextprotocol/server-memory version` (and the same for the
other three), and use exactly what it prints. Do not guess:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "kind": "npm",
      "id": "modelcontextprotocol-server-everything",
      "label": "server-everything",
      "package": "@modelcontextprotocol/server-everything",
      "version": "REPLACE_WITH_npm_view_OUTPUT",
      "bin": "mcp-server-everything",
      "transport": "stdio",
      "note": "official reference server"
    },
    {
      "kind": "npm",
      "id": "modelcontextprotocol-server-memory",
      "label": "server-memory",
      "package": "@modelcontextprotocol/server-memory",
      "version": "REPLACE_WITH_npm_view_OUTPUT",
      "bin": "mcp-server-memory",
      "transport": "stdio",
      "note": "official reference server"
    },
    {
      "kind": "npm",
      "id": "modelcontextprotocol-server-filesystem",
      "label": "server-filesystem",
      "package": "@modelcontextprotocol/server-filesystem",
      "version": "REPLACE_WITH_npm_view_OUTPUT",
      "bin": "mcp-server-filesystem",
      "transport": "stdio",
      "note": "official reference server"
    },
    {
      "kind": "npm",
      "id": "modelcontextprotocol-server-sequential-thinking",
      "label": "server-sequential-thinking",
      "package": "@modelcontextprotocol/server-sequential-thinking",
      "version": "REPLACE_WITH_npm_view_OUTPUT",
      "bin": "mcp-server-sequential-thinking",
      "transport": "stdio",
      "note": "official reference server"
    }
  ]
}
```

Confirm each `bin` name against the package's own manifest:
`npm view @modelcontextprotocol/server-memory bin`. Fix any that differ.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/index-scan.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the real cohort file validates**

```bash
node -e "
import('./scripts/scan-index.mjs').then(async (m) => {
  const { readFileSync } = await import('node:fs');
  console.log(m.loadTargets(readFileSync('index/targets.json','utf8')).length, 'targets valid');
});
"
```

Expected: `4 targets valid`. A failure here means a placeholder version was left in the file.

- [ ] **Step 6: Commit**

```bash
npx prettier --write scripts/scan-index.mjs scripts/scan-index.d.mts test/index-scan.test.ts index/targets.json
git add scripts/scan-index.mjs scripts/scan-index.d.mts test/index-scan.test.ts index/targets.json
git commit -m "feat(index): curated cohort with pinned-version validation"
```

---

### Task 4: Scanning — the offline path

**Files:**

- Modify: `scripts/scan-index.mjs`
- Modify: `scripts/scan-index.d.mts`
- Modify: `test/index-scan.test.ts`
- Create: `index/runs/.gitkeep`

**Interfaces:**

- Consumes: `loadTargets` (Task 3); `runChecks` and `StdioTransport` from the library.
- Produces:
  - `createProbe(lib: { runChecks; StdioTransport }): (target: Target, opts: { timeoutMs?: number }) => Promise<RunReport>`
  - `toResult(target: Target, report: RunReport): TargetResult`
  - `scanTargets(targets: Target[], opts: { probe; timeoutMs?: number; toolVersion: string; rulesetSize: number; now?: () => Date }): Promise<RunSnapshot>`

Why `probe` is injected: the CLI probes through the built `dist/`, exactly as a user would, while the test probes through `src/` so it runs without a build step. Same logic, no environment variables, no duplicated code path.

- [x] **Step 1: Write the failing test**

Append to `test/index-scan.test.ts`:

```typescript
import { fileURLToPath } from 'node:url';

import { createProbe, scanTargets, toResult } from '../scripts/scan-index.mjs';
import { runChecks } from '../src/run.js';
import { StdioTransport } from '../src/transport/stdio.js';
import { ALL_RULES } from '../src/rules/index.js';

const STDIO_SERVER = fileURLToPath(
  new URL('./fixtures/servers/stdio-server.mjs', import.meta.url),
);

function localTarget(id: string, mode: 'legacy' | 'modern') {
  return {
    kind: 'local' as const,
    id,
    label: id,
    command: `node "${STDIO_SERVER}" ${mode}`,
  };
}

const probe = createProbe({ runChecks, StdioTransport });

describe('scanTargets', () => {
  it('records a legacy server as not ready with its failing rules', async () => {
    const snapshot = await scanTargets([localTarget('legacy', 'legacy')], {
      probe,
      timeoutMs: 5000,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.results).toHaveLength(1);
    const result = snapshot.results[0]!;
    expect(result.ready).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.failedRules).toContain('MCP002');
    expect(result.unreachable).toBeNull();
  });

  it('records a compliant server as ready with no failing rules', async () => {
    const snapshot = await scanTargets([localTarget('modern', 'modern')], {
      probe,
      timeoutMs: 5000,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    const result = snapshot.results[0]!;
    expect(result.ready).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.failedRules).toEqual([]);
  });

  it('stores no evidence, so parseRunSnapshot accepts its own output', async () => {
    const snapshot = await scanTargets([localTarget('legacy', 'legacy')], {
      probe,
      timeoutMs: 5000,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    const { parseRunSnapshot } = await import('../scripts/aggregate-index.mjs');
    expect(() => parseRunSnapshot(JSON.stringify(snapshot))).not.toThrow();
  });

  it('marks a target that never answers as unreachable, not failing', async () => {
    const dead = {
      kind: 'local' as const,
      id: 'dead',
      label: 'dead',
      command: 'node --eval "process.exit(1)"',
    };

    const snapshot = await scanTargets([dead], {
      probe,
      timeoutMs: 2000,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    const result = snapshot.results[0]!;
    expect(result.unreachable).toBeTruthy();
    expect(result.errorCount).toBe(0);
    expect(result.failedRules).toEqual([]);
  });

  it('continues the sweep after one target fails', async () => {
    const dead = {
      kind: 'local' as const,
      id: 'dead',
      label: 'dead',
      command: 'node --eval "process.exit(1)"',
    };

    const snapshot = await scanTargets([dead, localTarget('modern', 'modern')], {
      probe,
      timeoutMs: 2000,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    expect(snapshot.results).toHaveLength(2);
    expect(snapshot.results[1]!.ready).toBe(true);
  });

  it('fails loudly when a rule crashes, because that is our bug', async () => {
    const crashingProbe = async () => ({
      target: 'x',
      transport: 'stdio' as const,
      targetRevision: '2026-07-28',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      outcomes: [
        { rule: { id: 'MCP001' }, findings: [], crashed: 'boom', durationMs: 1 },
      ],
      findings: [],
      errorCount: 0,
      warningCount: 0,
      ready: true,
      diagnostics: [],
    });

    await expect(
      scanTargets([localTarget('modern', 'modern')], {
        probe: crashingProbe as never,
        toolVersion: '0.0.0-test',
        rulesetSize: 18,
      }),
    ).rejects.toThrow(/crashed/i);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/index-scan.test.ts`
Expected: FAIL — `createProbe is not a function`.

- [x] **Step 3: Write the minimal implementation**

Append to `scripts/scan-index.mjs`:

```javascript
/**
 * Build a probe function from a library module.
 *
 * Injected rather than imported so the CLI can probe through the built dist/ —
 * the same code path users get — while tests probe through src/ with no build
 * step. One implementation either way.
 */
export function createProbe(lib) {
  return async function probe(target, opts = {}) {
    const command = target.kind === 'local' ? target.command : target.command;
    const transport = new lib.StdioTransport(command);
    try {
      return await lib.runChecks(transport, { timeoutMs: opts.timeoutMs });
    } finally {
      await transport.close();
    }
  };
}

export function toResult(target, report) {
  const crashed = report.outcomes.filter((o) => o.crashed);
  if (crashed.length > 0) {
    // A crashed rule is a bug in this tool, and publishing a number derived
    // from a partial run would hide it.
    throw new Error(
      `Rule(s) crashed probing ${target.id}: ${crashed.map((o) => o.rule.id).join(', ')}`,
    );
  }

  const base = {
    id: target.id,
    package: target.kind === 'npm' ? target.package : target.command,
    version: target.kind === 'npm' ? target.version : 'local',
    transport: 'stdio',
  };

  if (report.unreachable) {
    return {
      ...base,
      ready: false,
      errorCount: 0,
      warningCount: 0,
      sdkErrors: 0,
      applicationErrors: 0,
      failedRules: [],
      unreachable: report.unreachable,
    };
  }

  const errors = report.findings.filter((f) => f.severity === 'error');
  return {
    ...base,
    ready: report.ready,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    sdkErrors: errors.filter((f) => f.remediation === 'sdk').length,
    applicationErrors: errors.filter((f) => f.remediation === 'application').length,
    failedRules: [...new Set(errors.map((f) => f.ruleId))].sort(),
    unreachable: null,
  };
}

export async function scanTargets(targets, opts) {
  const now = opts.now ?? (() => new Date());
  const results = [];

  for (const target of targets) {
    // One target's failure never aborts the sweep. A thrown probe is recorded
    // as unreachable; only a crashed RULE stops everything, via toResult.
    let report;
    try {
      report = await opts.probe(target, { timeoutMs: opts.timeoutMs });
    } catch (err) {
      results.push({
        id: target.id,
        package: target.kind === 'npm' ? target.package : target.command,
        version: target.kind === 'npm' ? target.version : 'local',
        transport: 'stdio',
        ready: false,
        errorCount: 0,
        warningCount: 0,
        sdkErrors: 0,
        applicationErrors: 0,
        failedRules: [],
        unreachable: `probe failed: ${err.message}`,
      });
      continue;
    }
    results.push(toResult(target, report));
  }

  return {
    schemaVersion: 1,
    scannedAt: now().toISOString(),
    toolVersion: opts.toolVersion,
    rulesetSize: opts.rulesetSize,
    results,
  };
}
```

Add to `scripts/scan-index.d.mts`:

```typescript
import type { RunReport } from '../src/run.js';
import type { RunSnapshot, TargetResult } from './aggregate-index.d.mts';

export interface Lib {
  runChecks: typeof import('../src/run.js').runChecks;
  StdioTransport: typeof import('../src/transport/stdio.js').StdioTransport;
}

export function createProbe(
  lib: Lib,
): (target: Target, opts?: { timeoutMs?: number }) => Promise<RunReport>;

export function toResult(target: Target, report: RunReport): TargetResult;

export function scanTargets(
  targets: Target[],
  opts: {
    probe: (target: Target, opts?: { timeoutMs?: number }) => Promise<RunReport>;
    timeoutMs?: number;
    toolVersion: string;
    rulesetSize: number;
    now?: () => Date;
  },
): Promise<RunSnapshot>;
```

Create `index/runs/.gitkeep` (empty file), so the directory exists before the first run.

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/index-scan.test.ts`
Expected: PASS, 16 tests. Note `createProbe` currently reads `target.command` for both kinds — Task 5 replaces that line; the local path is what these tests exercise.

- [x] **Step 5: Run the full gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass, 100+ tests.

- [x] **Step 6: Commit**

```bash
npx prettier --write scripts/scan-index.mjs scripts/scan-index.d.mts test/index-scan.test.ts
git add scripts/scan-index.mjs scripts/scan-index.d.mts test/index-scan.test.ts index/runs/.gitkeep
git commit -m "feat(index): scan a cohort into a verdict snapshot"
```

---

#### Amendment (2026-08-31): what changed during implementation

Task 4 landed as `29c65ea` and was then hardened in response to an adversarial
review. Four deviations from the steps above:

1. **`createProbe` refuses an npm target** instead of reading `target.command`
   for both kinds via the placeholder ternary. That ternary would have spawned a
   bin that is not on the machine and recorded the resulting `ENOENT` as though
   the _server_ were at fault — the exact misattribution the unreachable split
   exists to prevent. Task 5 replaces the `throw` with a real install path.
2. **`Lib` gained `tokenizeCommand`.** A malformed command (unbalanced quoting,
   empty string) is caught inside the transport and surfaces as a transport
   error, indistinguishable from a server going dark — and the transport's
   message quotes the whole command line back, credentials included. `probe`
   now parses argv first and fails with a message that names neither.
3. **A third run state exists.** `runChecks` sets `RunReport.incomplete` when
   some probes got answers and others got none; no such run is `ready`, the CLI
   exits `2`, and `toResult` files the target as not measurable. See the
   amendment in the design spec. Without it a server that answered once and then
   died was published as `ready: true`.
4. **A local target is named `local:<id>`, never by its command.** The command
   carries absolute paths and whatever `--api-key` was passed, and `unreachable`
   is the only free-text field in the snapshot schema, so the aggregator's
   allow-list cannot inspect it.

**Carried into Task 5** — do not skip these:

- `createProbe` currently passes `timeoutMs: undefined` through to the
  transport's 10 s default, so a mute server costs roughly 100 s per target.
  The CLI needs an explicit `--timeout` and a per-target budget.
- The scanner CLI must **refuse to write a snapshot containing a local target**
  unless explicitly forced. `--allow-local` is exactly the flag a maintainer
  would use before committing a snapshot by hand, and `local:<id>` rows do not
  belong in published data.
- `StdioTransport`'s `stdoutBuffer` and `notes` are unbounded (the HTTP
  transport caps at 512 KB). Freed per target, so not cumulative, but Task 5 is
  the first code to point this at N third-party servers.

### Task 5: Installing npm targets, and the scanner CLI

**Files:**

- Modify: `scripts/scan-index.mjs`
- Modify: `scripts/scan-index.d.mts`
- Modify: `test/index-scan.test.ts`
- Create: `test/fixtures/fake-package/node_modules/@example/server-a/package.json`
- Create: `test/fixtures/fake-package/node_modules/@example/server-a/bin/cli.js`
- Modify: `package.json` (scripts)

**Interfaces:**

- Consumes: `loadTargets`, `scanTargets`, `createProbe` from Tasks 3–4.
- Produces:
  - `resolveNpmBin(installDir: string, pkg: string, binName: string): string` — absolute path to the bin's JS entry point.

> **Amended after the Task 3 review.** `loadTargets` validating `bin` does **not**
> make the resolved path safe, and an earlier draft of this plan implied it did.
> `binName` is only a key looked up in the manifest; the value joined onto the
> path comes from the **downloaded third-party package**, so a manifest declaring
> `"bin": {"server-a": "../../../../evil.js"}` escapes the install directory with
> nothing to stop it. Two requirements follow, both in `resolveNpmBin`:
>
> 1. **Containment.** After resolving, assert the path is inside
>    `join(installDir, 'node_modules', pkg)` — compare `path.resolve`d values, and
>    reject rather than probe if it is not.
> 2. **String-form `bin`.** When a manifest sets `bin` to a string rather than a
>    map, the declared `binName` is ignored entirely, so the reviewer-pinned name
>    would never be checked against what runs. Require that the string form is
>    only accepted when the package name's last segment equals `binName`.
>
> Both need a test with a fixture manifest, alongside the existing ones.

- `installTarget(target: NpmTarget, dir: string, run?): void`
- CLI: `node scripts/scan-index.mjs [--targets <file>] [--out <file>] [--allow-local] [--timeout <ms>]`

- [x] **Step 1: Write the failing test**

First create the fixture. `test/fixtures/fake-package/node_modules/@example/server-a/package.json`:

```json
{
  "name": "@example/server-a",
  "version": "1.2.3",
  "bin": { "server-a": "bin/cli.js" }
}
```

`test/fixtures/fake-package/node_modules/@example/server-a/bin/cli.js`:

```javascript
// Never executed; resolveNpmBin only needs the file to exist.
process.exit(0);
```

Then append to `test/index-scan.test.ts`:

```typescript
import { resolveNpmBin } from '../scripts/scan-index.mjs';

const FAKE_INSTALL = fileURLToPath(new URL('./fixtures/fake-package', import.meta.url));

describe('resolveNpmBin', () => {
  it('resolves a named bin from the package manifest', () => {
    const resolved = resolveNpmBin(FAKE_INSTALL, '@example/server-a', 'server-a');
    expect(resolved.replace(/\\/g, '/')).toMatch(/@example\/server-a\/bin\/cli\.js$/);
  });

  it('throws a useful error when the bin name is not declared', () => {
    expect(() => resolveNpmBin(FAKE_INSTALL, '@example/server-a', 'nope')).toThrow(
      /nope/,
    );
  });

  it('throws when the package is not installed', () => {
    expect(() => resolveNpmBin(FAKE_INSTALL, '@example/missing', 'x')).toThrow(
      /@example\/missing/,
    );
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/index-scan.test.ts`
Expected: FAIL — `resolveNpmBin is not a function`.

- [x] **Step 3: Write the minimal implementation**

Append to `scripts/scan-index.mjs`:

```javascript
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Find the JS entry point for a package's declared bin.
 *
 * Resolved from the manifest rather than from node_modules/.bin, so the server
 * is spawned as `node <file>` and no platform shim is involved. The repository
 * already has hard-won code for Windows batch shims in
 * src/transport/spawn-plan.ts; not needing it here is simpler than reusing it.
 */
export function resolveNpmBin(installDir, pkg, binName) {
  const manifestPath = join(installDir, 'node_modules', pkg, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the manifest for ${pkg}: ${err.message}`);
  }

  const bin = manifest.bin;
  const relative = typeof bin === 'string' ? bin : bin?.[binName];
  if (!relative) {
    throw new Error(
      `${pkg} declares no bin named ${JSON.stringify(binName)}. Declared: ${
        typeof bin === 'string'
          ? '(single unnamed bin)'
          : Object.keys(bin ?? {}).join(', ') || '(none)'
      }`,
    );
  }
  return join(installDir, 'node_modules', pkg, relative);
}

/**
 * Install one pinned target into its own directory.
 *
 * `--ignore-scripts` is not negotiable: install scripts are the classic
 * supply-chain vector, and a server that cannot start without one is out of
 * scope for the index.
 */
export function installTarget(target, dir, run = execFileSync) {
  run(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--prefix',
      dir,
      `${target.package}@${target.version}`,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
}
```

Then replace the first line of `createProbe`'s returned function:

```javascript
const command = target.kind === 'local' ? target.command : target.command;
```

with:

```javascript
let command;
let cleanup = () => {};
if (target.kind === 'local') {
  command = target.command;
} else {
  const dir = mkdtempSync(join(tmpdir(), `mcp-index-${target.id}-`));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  installTarget(target, dir);
  command = `node "${resolveNpmBin(dir, target.package, target.bin)}"`;
}
```

and change the `finally` block of the same function from:

```javascript
    } finally {
      await transport.close();
    }
```

to:

```javascript
    } finally {
      await transport.close();
      cleanup();
    }
```

Finally, add the CLI entry at the end of `scripts/scan-index.mjs`:

```javascript
// --- CLI -------------------------------------------------------------------

async function cli(argv) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { parseArgs } = await import('node:util');

  const { values } = parseArgs({
    args: argv,
    options: {
      targets: { type: 'string', default: 'index/targets.json' },
      out: { type: 'string' },
      'allow-local': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '20000' },
    },
  });

  const targets = loadTargets(readFileSync(values.targets, 'utf8'), {
    allowLocal: values['allow-local'],
  });

  // Probe through the built library, exactly as a user would.
  const lib = await import('../dist/index.js');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  const snapshot = await scanTargets(targets, {
    probe: createProbe(lib),
    timeoutMs: Number(values.timeout),
    toolVersion: pkg.version,
    rulesetSize: lib.ALL_RULES.length,
  });

  const out = values.out ?? `index/runs/${snapshot.scannedAt.slice(0, 10)}.json`;
  mkdirSync('index/runs', { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  const ready = snapshot.results.filter((r) => r.ready).length;
  const measurable = snapshot.results.filter((r) => !r.unreachable).length;
  process.stdout.write(
    `Wrote ${out}: ${ready}/${measurable} ready across ${snapshot.results.length} targets\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`scan-index failed: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
```

Add to `package.json` `scripts`, next to `index:aggregate`:

```json
"index:scan": "node scripts/scan-index.mjs",
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/index-scan.test.ts`
Expected: PASS, 19 tests.

- [x] **Step 5: Verify the real scan by hand (needs network)**

```bash
npm run build
npm run index:scan -- --out index/runs/manual-check.json --timeout 30000
node scripts/aggregate-index.mjs --snapshot index/runs/manual-check.json --history /dev/null 2>&1 | head -3
```

Expected: the scan prints a `Wrote …` line naming four targets, and the snapshot contains four results. Inspect one result and confirm it carries **no** `evidence` key.
Then discard the scratch output: `rm index/runs/manual-check.json`.

- [x] **Step 6: Commit**

```bash
npx prettier --write scripts/scan-index.mjs scripts/scan-index.d.mts test/index-scan.test.ts package.json
git add scripts/scan-index.mjs scripts/scan-index.d.mts test/index-scan.test.ts test/fixtures/fake-package package.json
git commit -m "feat(index): install pinned npm targets and add the scanner CLI"
```

---

#### Amendment (2026-08-31): what changed during implementation

Six deviations, five of them forced by something the steps above got wrong.

1. **The committed fixture would have been invisible.** `.gitignore` excludes
   `node_modules/` at every level, so
   `test/fixtures/fake-package/node_modules/@example/server-a/` would have been
   absent in CI while passing locally. Install trees are built into a temp
   directory in `beforeAll` instead, which also makes a hostile manifest a
   two-line variant rather than another committed package.
2. **`npm` cannot be spawned by name on Windows.** The first real scan failed
   on all four targets with `spawnSync npm.cmd EINVAL`: npm is a batch shim,
   and since the fix for CVE-2024-27980 Node refuses to spawn a `.cmd`
   directly. The plan's note that `planSpawn` was "simpler not to reuse" was
   right about the _bin_ and wrong about the _install_. `planSpawn` is now
   exported from `src/index.ts` — the scanner is its second consumer, and the
   alternative was a second copy of CVE handling in a script — and
   `installTarget` takes it as an option.
3. **The CLI needs `--lib`.** CI runs `npm test` before `npm run build` and
   `dist/` is gitignored, so a test that hard-coded `dist/` fails on a clean
   checkout. The default is still `../dist/index.js`, so the CLI probes what a
   user installs; the test builds on demand and passes `--lib`.
4. **`isDirectInvocation()`, not `import.meta.url === \`file://\${process.argv[1]}\``.**
   The plan reproduced the bug that silently no-opped Task 2's CLI on Windows.
   Five spawn-based tests now cover the CLI, because that is the only kind that
   would have caught it.
5. **A per-target wall-clock budget** (`--budget`, default 120 s). A
   per-request timeout applies once per probe, so a server that accepts a
   connection and answers nothing costs it about twenty times over.
6. **`--allow-local` requires `--out`.** It may not write into
   `index/runs/`, where a `local:<id>` row would look like published data.

**A library bug the budget exposed.** `StdioTransport.send` caught write
failures synchronously, but a write to an ended pipe fails _asynchronously_ —
so closing a transport while a run was still in flight produced an uncaught
`write after end` and took the process down. Any caller with a timeout could
hit it. Fixed with a `stdin` error listener and a writability check, covered by
`test/close-during-run.test.ts`.

**A verification bug of my own, worth recording.** The mutation harness reported
17 of 18 guards caught while its own baseline was already failing: one of my new
tests asserted a directory was gone by spawning `node -e statSync`, whose crash
reached vitest as an unhandled error and made the run exit non-zero. Every
mutant therefore read as CAUGHT. I had been grepping stdout for "Tests" and
never checking the exit code. The harness now refuses to run unless the baseline
is green, and re-running it found **two genuinely unpinned guards** —
prototype lookups in the `bin` map, and the atomic write — both now covered.

**Verified by hand against the real cohort** (`npm run build` then a scan with
`--timeout 30000`): four of four measurable, 0/4 ready, 33 breaking findings,
**every one of them `sdk` and none `application`** — the project's thesis in
real numbers. The snapshot contains exactly the eleven allowed keys and no
occurrence of `evidence`, `requestHeaders`, `authorization` or `Bearer`.
Aggregating it produced a history row of `0/4 ready (median 8 breaking)`.

### Task 6: The weekly workflow

**Files:**

- Create: `.github/workflows/index.yml`
- Modify: `docs/ARCHITECTURE.md` (repo map, and the CI section)
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `npm run index:scan`, `npm run index:aggregate` from Tasks 2 and 5.
- Produces: a weekly commit of `index/runs/<date>.json` and an updated `index/history.json`.

- [x] **Step 1: Write the workflow**

Create `.github/workflows/index.yml`:

```yaml
name: Compliance index

on:
  schedule:
    # Mondays, 06:00 UTC.
    - cron: '0 6 * * 1'
  workflow_dispatch:

concurrency:
  group: index
  cancel-in-progress: false

jobs:
  # This job runs third-party code. It therefore holds NO credentials: no
  # GITHUB_TOKEN, no npm cache write, no secrets. A compromised upstream release
  # finds nothing to steal and no way to push to this repository.
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions: {}
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - uses: actions/setup-node@v7
        with:
          node-version: '22'

      - run: npm ci
      - run: npm run build

      - name: Probe the cohort
        run: npm run index:scan -- --out snapshot.json --timeout 30000

      - uses: actions/upload-artifact@v4
        with:
          name: index-snapshot
          path: snapshot.json
          retention-days: 7

  # This job holds a write credential and therefore never executes target code.
  # It only parses JSON it validates first.
  commit:
    needs: scan
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          cache: npm

      - uses: actions/download-artifact@v4
        with:
          name: index-snapshot

      - name: Validate and aggregate
        run: |
          date="$(node -p "require('./snapshot.json').scannedAt.slice(0,10)")"
          mkdir -p index/runs
          cp snapshot.json "index/runs/$date.json"
          node scripts/aggregate-index.mjs --snapshot "index/runs/$date.json"

      - name: Commit the run
        run: |
          date="$(node -p "require('./snapshot.json').scannedAt.slice(0,10)")"
          rm -f snapshot.json
          if git diff --quiet index/; then
            echo "No change in index/ — nothing to commit."
            exit 0
          fi
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add index/
          git commit -m "chore(index): weekly scan $date"
          git push
```

- [x] **Step 2: Verify the workflow is well-formed and its jobs are correctly scoped**

```bash
node -e "
const s = require('fs').readFileSync('.github/workflows/index.yml','utf8');
const scanBlock = s.slice(s.indexOf('  scan:'), s.indexOf('  commit:'));
console.log('scan job declares empty permissions:', /permissions:\s*\{\}/.test(scanBlock));
console.log('scan job avoids persisted credentials:', /persist-credentials:\s*false/.test(scanBlock));
console.log('scan job has no npm cache:', !/cache:\s*npm/.test(scanBlock));
console.log('tabs present:', /\t/.test(s));
"
```

Expected: `true`, `true`, `true`, `false`. Any other combination means the credential split is not real.

- [x] **Step 3: Dry-run the aggregate half locally**

```bash
npm run build
npm run index:scan -- --out snapshot.json --timeout 30000
date="$(node -p "require('./snapshot.json').scannedAt.slice(0,10)")"
mkdir -p index/runs && cp snapshot.json "index/runs/$date.json"
node scripts/aggregate-index.mjs --snapshot "index/runs/$date.json"
git diff --stat index/
```

Expected: one new snapshot file and one added row in `index/history.json`.
Keep this run — it is the index's first real data point.

- [x] **Step 4: Document it**

In `docs/ARCHITECTURE.md`, add to the repo map (§4), after the `site/` line:

```
index/                 compliance-index cohort, run snapshots and history
```

And in §12, after the `pages.yml` paragraph:

```markdown
**[index.yml](../.github/workflows/index.yml)** — probes the curated cohort in
`index/targets.json` weekly and commits the result. Split into two jobs on
purpose: `scan` runs third-party code with `permissions: {}` and no persisted
credentials, then hands a snapshot to `commit`, which holds `contents: write`
and never executes target code. Only verdicts and rule ids are stored, never
evidence — republishing other projects' wire traffic would be both bulky and
rude, and every row can be reproduced with one printed command.
```

Add to `CHANGELOG.md` under `## [Unreleased]` → `### Added`:

```markdown
- A weekly ecosystem compliance index: a curated, version-pinned cohort probed
  by CI, with an append-only history whose git log is the audit trail.
```

- [x] **Step 5: Run the full gates**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run docs:check && npm test`
Expected: all pass.

- [x] **Step 6: Commit**

```bash
npx prettier --write docs/ARCHITECTURE.md CHANGELOG.md index/history.json
git add .github/workflows/index.yml docs/ARCHITECTURE.md CHANGELOG.md index/
git commit -m "feat(index): weekly workflow with a credential-isolated scan job"
```

- [ ] **Step 7: Trigger it once by hand and confirm it is green**

Push the branch, then run the workflow from the Actions tab via `workflow_dispatch`. Confirm: the `scan` job's rendered permissions list is empty, `commit` produces a commit, and the resulting `index/history.json` row matches the local dry-run from Step 3.

---

#### Amendment (2026-08-31): what changed during implementation

Two changes, one of which mattered.

1. **The committing job no longer builds a path in its shell.** The steps above
   had it derive the run filename with
   `date="$(node -p "require('./snapshot.json').scannedAt.slice(0,10)")"`.
   Command substitution happens inside double quotes, so that places an
   unvalidated field from a file produced alongside third-party code onto a
   command line in the one job holding `contents: write` — breaking this
   design's own rule that the job only parses JSON it has validated first.
   `scannedAt` is generated by our own code, so it was not exploitable; the
   shape was wrong regardless. `aggregate-index.mjs` now takes `--runs-dir` and
   places the run file itself, from a validated date, writing through a
   temporary file and renaming.
2. **`git status --porcelain` instead of `git diff --quiet`.** The new run file
   is untracked, so a diff of tracked files alone would report "no change" on a
   re-run whose history row came out identical, and skip the commit.

Also added, beyond the steps: an `if: github.repository == …` guard so a fork
does not run the cron and try to push to itself, and `--budget` on the scan,
since `--timeout` is per-request and bounds nothing per target.

**The credential split is now a test.** The plan verified it with a one-off
`node -e` snippet, which checks the file on the day you run it and never again.
`test/index-workflow.test.ts` asserts it on every `npm test`: sixteen
assertions, and fifteen mutations of the workflow each caught. One of those
mutations exposed a flaw in the test itself — a comment _explaining_ why we
avoid `git diff --quiet` satisfied the assertion that we avoid it, so comments
are stripped before the negative assertions run.

**Step 7 remains open**, and only the repository owner can close it: it needs a
`workflow_dispatch` run on GitHub to confirm the rendered permissions are empty
and that `commit` pushes. Everything up to that point is verified locally,
including the full pipeline run that produced the first data point.

### Task 7: Site integration — COORDINATE FIRST

**Do not start this task until the concurrent website work is merged or paused.** Every file here is owned by that effort. Confirm with the user first.

> **This task is stale as written (amended 2026-08-31).** The website work
> landed: `site/` is now Astro + Starlight, and it renders the repository's own
> Markdown through a custom content loader. Three of the four files below no
> longer exist. The task's _intent_ is unchanged — import the canonical JSON,
> render headline, trend and cohort table, redeploy on a results commit — but
> re-read `site/` before following any snippet here. See
> [the documentation site design](../specs/2026-08-31-docs-site-design.md).
>
> | Was                               | Now                                                                                                                |
> | --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
> | `site/vite.config.ts`             | `site/astro.config.ts`, under `vite.resolve.alias`                                                                 |
> | `site/src/App.tsx`                | `site/src/pages/index.astro`                                                                                       |
> | `site/src/components/Section.tsx` | `<section class="band">` + `src/styles/landing.css`                                                                |
> | `IndexSection.tsx` (React)        | prefer `IndexSection.astro` — the trend line and table are static at build time and need no client-side JavaScript |
>
> `pages.yml`'s path filter is also no longer one line; add `index/**` to the
> existing list rather than replacing it.

**Files:**

- Modify: `site/astro.config.ts` (was `site/vite.config.ts`)
- Create: `site/src/components/IndexSection.astro` (was `.tsx`)
- Modify: `site/src/pages/index.astro` (was `site/src/App.tsx`)
- Modify: `.github/workflows/pages.yml`

**Interfaces:**

- Consumes: `index/history.json` and the newest `index/runs/<date>.json`.
- Produces: a rendered section on the landing page.

- [ ] **Step 1: Let the site read the canonical data**

In `site/vite.config.ts`, add to the config object:

```typescript
  resolve: {
    alias: { '@index': path.resolve(__dirname, '../index') },
  },
  server: { fs: { allow: ['..'] } },
```

with `import path from 'node:path';` at the top. The alias means the site
imports the same JSON that CI commits — no duplicated copy to drift.

- [ ] **Step 2: Add the section component**

Create `site/src/components/IndexSection.tsx`:

```tsx
import history from '@index/history.json';

/**
 * Ecosystem compliance index.
 *
 * The table is the accessible source of truth; the sparkline is decorative and
 * aria-hidden, with the same numbers stated in prose beside it. No chart
 * library — the same reasoning as the CLI's hand-rolled ANSI.
 */
interface Row {
  date: string;
  toolVersion: string;
  rulesetSize: number;
  cohortSize: number;
  measured: number;
  unreachable: number;
  ready: number;
  medianErrors: number | null;
  sdkErrors: number;
  applicationErrors: number;
  ruleFailureCounts: Record<string, number>;
}

const rows = (history as { rows: Row[] }).rows;

function readyPercent(row: Row): number {
  return row.measured === 0 ? 0 : Math.round((row.ready / row.measured) * 100);
}

/** A polyline over the ready-percentage series, scaled to a 300×60 box. */
function Sparkline({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const points = series
    .map((value, i) => {
      const x = (i / (series.length - 1)) * 300;
      const y = 60 - (value / 100) * 60;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox="0 0 300 60" className="h-16 w-full" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export default function IndexSection() {
  const latest = rows[rows.length - 1];
  if (!latest) return null;

  const rulesetChanged = new Set(rows.map((r) => r.rulesetSize)).size > 1;

  return (
    <section>
      <h2>Ecosystem compliance index</h2>
      <p>
        Of {latest.measured} servers measurable on {latest.date}, {latest.ready} are ready
        — {readyPercent(latest)}%. Median breaking findings: {latest.medianErrors ?? '—'}.{' '}
        {latest.unreachable > 0 &&
          `${latest.unreachable} could not be measured and are excluded from every total.`}
      </p>

      <Sparkline series={rows.map(readyPercent)} />
      {rulesetChanged && (
        <p>
          The ruleset has changed over this period, so earlier points were measured
          against a different number of checks.
        </p>
      )}

      <table>
        <caption>Ready share by scan date</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Ready</th>
            <th scope="col">Measured</th>
            <th scope="col">Not measurable</th>
            <th scope="col">Median breaking</th>
            <th scope="col">Checks</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((row) => (
            <tr key={row.date}>
              <td>{row.date}</td>
              <td>
                {row.ready} ({readyPercent(row)}%)
              </td>
              <td>{row.measured}</td>
              <td>{row.unreachable}</td>
              <td>{row.medianErrors ?? '—'}</td>
              <td>{row.rulesetSize}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

Styling: match whatever `site/src/components/Section.tsx` already does — read it first and reuse its classes rather than inventing new ones.

- [ ] **Step 3: Mount it**

In `site/src/App.tsx`, import `IndexSection` and render it after the existing "what it checks" section.

- [ ] **Step 4: Redeploy on data changes**

In `.github/workflows/pages.yml`, change the `paths` filter from:

```yaml
paths: ['site/**', '.github/workflows/pages.yml']
```

to:

```yaml
paths: ['site/**', 'index/**', '.github/workflows/pages.yml']
```

- [ ] **Step 5: Verify the site builds and renders real numbers**

```bash
cd site && npm ci && npm run lint && npm run format:check && npm run build
```

Expected: all pass. Then `npm run dev` and confirm the section shows the row committed in Task 6, not placeholder text.

- [ ] **Step 6: Commit**

```bash
cd site && npx prettier --write src/components/IndexSection.tsx src/App.tsx vite.config.ts && cd ..
git add site/src/components/IndexSection.tsx site/src/App.tsx site/vite.config.ts .github/workflows/pages.yml
git commit -m "feat(site): render the ecosystem compliance index"
```

---

## Self-Review

**Spec coverage:** every section of the spec maps to a task — cohort definition and pinning (3), scanner with `--ignore-scripts` (5), pure aggregation and history (1, 2), two-job credential-split workflow (6), site rendering with the accessible table and ruleset marker (7), error-handling matrix (1 for exclusion from denominators, 4 for unreachable and crash-loudly, 2 for the zero-measurable refusal), verdicts-not-evidence (enforced by a _test_ in 1 and asserted again in 4), and the non-goals (no HTTP targets, no badges, no backend — nothing in any task adds them).

**Type consistency:** `TargetResult`, `RunSnapshot`, `HistoryRow` and `History` are declared once in `aggregate-index.d.mts` and referenced from `scan-index.d.mts`. `summarise`, `parseRunSnapshot`, `parseHistory`, `upsertRow`, `loadTargets`, `createProbe`, `toResult`, `scanTargets`, `resolveNpmBin`, `installTarget` keep the same names and shapes everywhere they appear.

**Known rough edge, deliberately left:** Task 4 writes `createProbe` with a redundant ternary that Task 5 replaces. This is called out in Task 4 Step 4 rather than hidden, because splitting the local and npm paths into separate tasks is what keeps Task 4 testable with no network.

**Placeholders:** the only intentional one is `REPLACE_WITH_npm_view_OUTPUT` in Task 3, with the exact command that resolves it and a Step 5 that fails if it is left in place. Guessing four version numbers into a spec would be worse.
