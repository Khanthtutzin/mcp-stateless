/**
 * Probe the curated compliance-index cohort.
 *
 * This module owns every side effect the index needs: installing packages,
 * spawning servers, writing snapshots. The aggregation it feeds is pure and
 * lives in scripts/aggregate-index.mjs.
 *
 * `loadTargets` is the security boundary. Everything downstream trusts that a
 * target names a registry package at an exact version and nothing else, because
 * the workflow's whole argument is that a reviewer pinned every line of code the
 * cohort executes. It validates against an ALLOW-LIST for the same reason the
 * snapshot parser does: a check that only looks for keys it dislikes cannot see
 * the key nobody thought of.
 */

/** Root keys a targets file may carry. */
const TARGETS_KEYS = ['schemaVersion', 'targets'];

/** Keys each kind of target may carry, and which of them are required. */
const TARGET_SHAPES = {
  npm: {
    required: ['kind', 'id', 'label', 'package', 'version', 'bin', 'transport'],
    optional: ['note'],
  },
  local: {
    required: ['kind', 'id', 'label', 'command'],
    optional: ['note'],
  },
};

/** Exact semver only: no ranges, no dist-tags, no partial versions. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * An ordinary npm package name, scoped or not.
 *
 * This is a security control, not tidiness. `npm install` also accepts git URLs,
 * tarball URLs and filesystem paths, any of which would install code that no
 * pinned version describes — defeating the point of pinning. Only a registry
 * name is allowed through.
 */
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A bin *name*, never a path: it is joined onto an install directory. */
const BIN_NAME = /^[A-Za-z0-9._-]+$/;

/** Ids appear in committed JSON and as labels, so they stay boring. */
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;

function isText(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Reject any key outside `allowed`. */
function rejectUnknownKeys(keys, allowed, where) {
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${where} has an unexpected key ${JSON.stringify(key)}. Allowed: ${allowed.join(', ')}.`,
      );
    }
  }
}

/**
 * Parse and validate a targets file.
 *
 * @param text     Contents of a targets JSON file.
 * @param options  `allowLocal` permits `kind: "local"` targets, which spawn a
 *                 given command with nothing installed. Only the test suite
 *                 passes it; the published cohort must never contain one, or a
 *                 fixture could end up in real data.
 */
export function loadTargets(text, options = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Targets file is not valid JSON: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Targets file must be an object.');
  }

  rejectUnknownKeys(Object.keys(raw), TARGETS_KEYS, 'Targets file');

  if (raw.schemaVersion !== 1) {
    throw new Error(
      `Unsupported targets schemaVersion ${JSON.stringify(raw.schemaVersion)}; expected 1.`,
    );
  }
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new Error('Targets file must list at least one target.');
  }

  const seen = new Set();
  for (const [index, target] of raw.targets.entries()) {
    if (target === null || typeof target !== 'object' || Array.isArray(target)) {
      throw new Error(
        `Target at index ${index} must be an object, got ${JSON.stringify(target)}.`,
      );
    }

    const shape = TARGET_SHAPES[target.kind];
    if (!shape) {
      throw new Error(
        `Target at index ${index} has unknown kind ${JSON.stringify(target.kind)}. Expected "npm" or "local".`,
      );
    }

    const named = `Target ${JSON.stringify(target.id ?? `#${index}`)}`;
    rejectUnknownKeys(Object.keys(target), [...shape.required, ...shape.optional], named);
    for (const field of shape.required) {
      if (!(field in target)) throw new Error(`${named} is missing ${field}.`);
    }

    if (!isText(target.id) || !TARGET_ID.test(target.id)) {
      throw new Error(
        `${named}: id must be a lowercase slug like "modelcontextprotocol-server-memory", got ${JSON.stringify(target.id)}.`,
      );
    }
    if (!isText(target.label)) {
      throw new Error(`${named}: label must be a non-empty string.`);
    }
    if ('note' in target && !isText(target.note)) {
      throw new Error(`${named}: note must be a non-empty string when present.`);
    }

    if (target.kind === 'local') {
      if (!options.allowLocal) {
        throw new Error(
          `${named} is a local target. Pass --allow-local to scan it; the published cohort must not contain one.`,
        );
      }
      if (!isText(target.command)) {
        throw new Error(`${named}: command must be a non-empty string.`);
      }
    } else {
      if (!isText(target.package) || !PACKAGE_NAME.test(target.package)) {
        throw new Error(
          `${named}: package must be a plain npm package name, got ${JSON.stringify(target.package)}. Git URLs, tarball URLs and file paths are refused — they would install code no pinned version describes.`,
        );
      }
      if (!isText(target.version) || !EXACT_VERSION.test(target.version)) {
        throw new Error(
          `${named}: version must be an exact version like "1.2.3", got ${JSON.stringify(target.version)}. Ranges and dist-tags let an upstream release change the numbers and the executed code with no review.`,
        );
      }
      if (!isText(target.bin) || !BIN_NAME.test(target.bin)) {
        throw new Error(
          `${named}: bin must be a bin name, not a path, got ${JSON.stringify(target.bin)}.`,
        );
      }
      // The cohort is stdio-only. Probing a hosted endpoint on a cron without
      // its operator's consent is not something this project does.
      if (target.transport !== 'stdio') {
        throw new Error(
          `${named}: transport must be "stdio", got ${JSON.stringify(target.transport)}. Hosted endpoints are only added with the operator's consent.`,
        );
      }
    }

    if (seen.has(target.id)) {
      throw new Error(`Duplicate target id ${JSON.stringify(target.id)}.`);
    }
    seen.add(target.id);
  }

  return raw.targets;
}
