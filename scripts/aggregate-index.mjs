import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Aggregate one compliance-index run into a single history row.
 *
 * Everything exported here is pure: no file reads, no network, no clock. That is
 * what makes the numbers destined for the site testable, and it mirrors the
 * rules/transport split in src/ — the thing worth testing does not touch the
 * thing that touches the world.
 *
 * `parseRunSnapshot` is a trust boundary, not a formality. The workflow's whole
 * security argument is that the job holding a write credential never executes
 * target code and only commits JSON it has validated, so this validator is what
 * that claim rests on. It therefore uses an ALLOW-LIST: anything not named here
 * is rejected. An earlier version listed a few forbidden field names instead and
 * was inert, because the fields that actually carry wire traffic
 * (`findings[].evidence[].requestHeaders`, `diagnostics`) sit below the level it
 * inspected.
 */

/** The only keys a snapshot may carry. */
const SNAPSHOT_KEYS = [
  'schemaVersion',
  'scannedAt',
  'toolVersion',
  'rulesetSize',
  'results',
];

/** The only keys a result may carry, and how each is validated. */
const RESULT_FIELDS = {
  id: 'text',
  package: 'text',
  version: 'text',
  transport: 'transport',
  ready: 'boolean',
  errorCount: 'count',
  warningCount: 'count',
  sdkErrors: 'count',
  applicationErrors: 'count',
  failedRules: 'ruleIds',
  unreachable: 'reason',
};

/**
 * Keys that mean someone spread a `RunReport` (or an `Exchange`) into a result.
 * The allow-list already rejects them; this list only buys a better message,
 * because "unexpected key" undersells what is about to be published.
 */
const EVIDENCE_KEYS = [
  'evidence',
  'transcript',
  'requestHeaders',
  'responseHeaders',
  'findings',
  'outcomes',
  'diagnostics',
];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Validate one result field, returning an error message or null. */
function checkField(kind, value) {
  switch (kind) {
    case 'text':
      return isText(value) ? null : 'must be a non-empty string';
    case 'transport':
      return value === 'stdio' || value === 'http' ? null : 'must be "stdio" or "http"';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'count':
      return isCount(value) ? null : 'must be a non-negative integer';
    case 'ruleIds':
      return Array.isArray(value) && value.every(isText)
        ? null
        : 'must be an array of rule ids';
    case 'reason':
      // Null means measured. An empty string would be falsy and would silently
      // count as measured while carrying no numbers, so it is rejected.
      return value === null || isText(value)
        ? null
        : 'must be null or a non-empty reason string';
    default:
      return `has no validator for ${kind}`;
  }
}

/** Reject any key outside `allowed`, naming evidence-bearing keys specifically. */
function rejectUnknownKeys(keys, allowed, where) {
  for (const key of keys) {
    if (allowed.includes(key)) continue;
    if (EVIDENCE_KEYS.includes(key)) {
      throw new Error(
        `${where} carries ${key}. The index stores verdicts, never evidence — that field can hold request headers, response bodies or captured stderr.`,
      );
    }
    throw new Error(`${where} has an unexpected key ${JSON.stringify(key)}.`);
  }
}

export function parseRunSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Snapshot is not valid JSON: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Snapshot must be an object.');
  }

  rejectUnknownKeys(Object.keys(raw), SNAPSHOT_KEYS, 'Snapshot');

  if (raw.schemaVersion !== 1) {
    throw new Error(
      `Unsupported snapshot schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected 1.`,
    );
  }
  // `date` is derived by slicing this, so a non-timestamp would become the
  // row's date and corrupt the ordering of an append-only file.
  if (typeof raw.scannedAt !== 'string' || !ISO_TIMESTAMP.test(raw.scannedAt)) {
    throw new Error(
      `Snapshot scannedAt must be an ISO 8601 timestamp, got ${JSON.stringify(raw.scannedAt)}.`,
    );
  }
  if (!isText(raw.toolVersion)) {
    throw new Error(
      `Snapshot toolVersion must be a non-empty string, got ${JSON.stringify(raw.toolVersion)}.`,
    );
  }
  if (!Number.isInteger(raw.rulesetSize) || raw.rulesetSize < 1) {
    throw new Error(
      `Snapshot rulesetSize must be a positive integer, got ${JSON.stringify(raw.rulesetSize)}.`,
    );
  }
  if (!Array.isArray(raw.results)) {
    throw new Error('Snapshot results must be an array.');
  }

  const seen = new Set();
  for (const [index, result] of raw.results.entries()) {
    const where = `Result at index ${index}`;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(`${where} must be an object, got ${JSON.stringify(result)}.`);
    }

    const named = `Result ${JSON.stringify(result.id ?? `#${index}`)}`;
    rejectUnknownKeys(Object.keys(result), Object.keys(RESULT_FIELDS), named);

    for (const [field, kind] of Object.entries(RESULT_FIELDS)) {
      if (!(field in result)) throw new Error(`${named} is missing ${field}.`);
      const problem = checkField(kind, result[field]);
      if (problem) {
        throw new Error(
          `${named} field ${field} ${problem}, got ${JSON.stringify(result[field])}.`,
        );
      }
    }

    if (seen.has(result.id)) {
      throw new Error(`Duplicate result id ${JSON.stringify(result.id)}.`);
    }
    seen.add(result.id);
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
  // start is "not measurable", never "failing" — the same principle as the CLI's
  // refusal to turn a launch failure into eighteen verdicts. Compared against
  // null rather than by truthiness so no falsy reason can slip through.
  const measured = results.filter((r) => r.unreachable === null);

  // A null-prototype accumulator: rule ids are data, and on a plain object an id
  // of "__proto__" silently discards its count while "constructor" stringifies a
  // function into the committed JSON.
  const counts = Object.create(null);
  for (const r of measured) {
    for (const id of r.failedRules) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  // Sorted so the committed JSON has a stable key order and a diff between two
  // runs shows what actually changed. fromEntries defines own properties, so a
  // prototype-colliding id stays a plain data key.
  const ruleFailureCounts = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((id) => [id, counts[id]]),
  );

  return {
    date: snapshot.scannedAt.slice(0, 10),
    toolVersion: snapshot.toolVersion,
    rulesetSize: snapshot.rulesetSize,
    cohortSize: results.length,
    measured: measured.length,
    unreachable: results.length - measured.length,
    ready: measured.filter((r) => r.ready).length,
    medianErrors: median(measured.map((r) => r.errorCount)),
    sdkErrors: measured.reduce((n, r) => n + r.sdkErrors, 0),
    applicationErrors: measured.reduce((n, r) => n + r.applicationErrors, 0),
    ruleFailureCounts,
  };
}

// --- History ---------------------------------------------------------------

/** The only keys a history row may carry, and how each is validated. */
const ROW_FIELDS = {
  date: 'date',
  toolVersion: 'text',
  rulesetSize: 'positive',
  cohortSize: 'count',
  measured: 'count',
  unreachable: 'count',
  ready: 'count',
  medianErrors: 'optionalNumber',
  sdkErrors: 'count',
  applicationErrors: 'count',
  ruleFailureCounts: 'counts',
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Validate one history-row field, returning an error message or null. */
function checkRowField(kind, value) {
  switch (kind) {
    case 'date':
      return typeof value === 'string' && DATE_ONLY.test(value)
        ? null
        : 'must be a YYYY-MM-DD date';
    case 'text':
      return isText(value) ? null : 'must be a non-empty string';
    case 'positive':
      return Number.isInteger(value) && value > 0 ? null : 'must be a positive integer';
    case 'count':
      return isCount(value) ? null : 'must be a non-negative integer';
    case 'optionalNumber':
      // Null when nothing was measurable; fractional when an even cohort
      // averaged its two middle values.
      return value === null || (typeof value === 'number' && Number.isFinite(value))
        ? null
        : 'must be null or a finite number';
    case 'counts':
      return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every(isCount)
        ? null
        : 'must be an object of rule ids to non-negative integers';
    default:
      return `has no validator for ${kind}`;
  }
}

/**
 * Parse `index/history.json`.
 *
 * Validated as strictly as a run snapshot, for a different reason: this file is
 * committed, append-only, and read by the site. One malformed row would render
 * a percentage over 100% or corrupt the ordering of the trend, and it would keep
 * doing so every week afterwards.
 */
export function parseHistory(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`History is not valid JSON: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('History must be an object.');
  }

  rejectUnknownKeys(Object.keys(raw), ['schemaVersion', 'rows'], 'History');

  if (raw.schemaVersion !== 1) {
    throw new Error(
      `Unsupported history schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected 1.`,
    );
  }
  if (!Array.isArray(raw.rows)) throw new Error('History rows must be an array.');

  const seen = new Set();
  for (const [index, row] of raw.rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`History row at index ${index} must be an object.`);
    }
    const named = `History row ${JSON.stringify(row.date ?? `#${index}`)}`;
    rejectUnknownKeys(Object.keys(row), Object.keys(ROW_FIELDS), named);

    for (const [field, kind] of Object.entries(ROW_FIELDS)) {
      if (!(field in row)) throw new Error(`${named} is missing ${field}.`);
      const problem = checkRowField(kind, row[field]);
      if (problem) {
        throw new Error(
          `${named} field ${field} ${problem}, got ${JSON.stringify(row[field])}.`,
        );
      }
    }

    // Arithmetic the renderer relies on. A row that does not add up produces
    // nonsense on the page rather than an error, which is worse.
    if (row.measured + row.unreachable !== row.cohortSize) {
      throw new Error(
        `${named}: measured (${row.measured}) plus unreachable (${row.unreachable}) must equal cohortSize (${row.cohortSize}).`,
      );
    }
    if (row.ready > row.measured) {
      throw new Error(
        `${named}: ready (${row.ready}) cannot exceed measured (${row.measured}).`,
      );
    }

    if (seen.has(row.date)) {
      throw new Error(`Duplicate history row for ${JSON.stringify(row.date)}.`);
    }
    seen.add(row.date);
  }

  return raw;
}

/**
 * Add a row, replacing any row already recorded for the same date.
 *
 * Re-running a scan for a given day corrects that day. Appending instead would
 * double-count the cohort in the trend, and the file is append-only in the sense
 * that history is never rewritten — not that a mistake can never be fixed.
 * Returns a new object; the input is left alone.
 */
export function upsertRow(history, row) {
  const rows = history.rows.filter((existing) => existing.date !== row.date);
  rows.push(row);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { ...history, rows };
}

/**
 * Fold a run snapshot into a history: parse both, summarise, upsert.
 *
 * The zero-measurable refusal lives here rather than in the CLI so that it is
 * testable. A row of zeroes would be a false datum, not a measurement — the
 * same reasoning that makes an unreachable server report no findings at all.
 */
export function applySnapshot(snapshotText, historyText) {
  const row = summarise(parseRunSnapshot(snapshotText));
  if (row.measured === 0) {
    throw new Error(
      `Nothing was measurable in the run of ${row.date} (${row.unreachable} of ${row.cohortSize} targets unreachable); refusing to record a row.`,
    );
  }
  return { history: upsertRow(parseHistory(historyText), row), row };
}

// --- CLI -------------------------------------------------------------------

/**
 * Only this entry point touches the filesystem. Keeping it below the exports,
 * and behind a direct-invocation check, is what lets the tests import the pure
 * half without a build step or a temp directory.
 *
 *   node scripts/aggregate-index.mjs --snapshot index/runs/2026-09-07.json
 */
async function cli(argv) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { parseArgs } = await import('node:util');

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        snapshot: { type: 'string' },
        history: { type: 'string', default: 'index/history.json' },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  if (!values.snapshot) {
    process.stderr.write(
      'Usage: node scripts/aggregate-index.mjs --snapshot <file> [--history <file>]\n',
    );
    return 2;
  }

  const { history, row } = applySnapshot(
    readFileSync(values.snapshot, 'utf8'),
    readFileSync(values.history, 'utf8'),
  );

  writeFileSync(values.history, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${row.date}: ${row.ready}/${row.measured} ready` +
      `${row.unreachable ? `, ${row.unreachable} not measurable` : ''}` +
      ` (median ${row.medianErrors} breaking, ruleset ${row.rulesetSize})\n`,
  );
  return 0;
}

/**
 * True when this file was run directly rather than imported.
 *
 * Compared via realpath, exactly as src/cli/index.ts does it. The obvious
 * version — `import.meta.url === \`file://${process.argv[1]}\`` — never matches
 * on Windows, where argv[1] is `C:\dir\file.mjs` and import.meta.url is
 * `file:///C:/dir/file.mjs`, percent-encoded. The failure is silent: the script
 * runs, does nothing, and exits 0.
 */
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
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
