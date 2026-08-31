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
