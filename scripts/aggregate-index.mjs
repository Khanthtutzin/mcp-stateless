/**
 * Aggregate one compliance-index run into a single history row.
 *
 * Everything exported here is pure: no file reads, no network, no clock. That
 * is what makes the numbers on the site testable, and it mirrors the
 * rules/transport split in src/ — the thing worth testing does not touch the
 * thing that touches the world. Only the CLI entry at the bottom does I/O.
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

  const counts = {};
  for (const r of measured) {
    for (const id of r.failedRules) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  // Sorted so the committed JSON has a stable key order and a diff between two
  // runs shows what actually changed.
  const ruleFailureCounts = {};
  for (const id of Object.keys(counts).sort()) {
    ruleFailureCounts[id] = counts[id];
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
    ruleFailureCounts,
  };
}
