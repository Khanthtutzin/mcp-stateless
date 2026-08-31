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

const VERSION_SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * One immutable release, as npm would resolve it.
 *
 * A regex alone is not enough, and the gap is not academic. npm classifies a
 * spec as a *version* only when semver can parse it; anything else it treats as
 * a **dist-tag** and asks the registry what that tag currently points at. Both
 * `1.2.3-.` and `9007199254740993.0.0` look numeric, pass a shape check, and are
 * legal tag names — so a publisher could repoint the executed code at will,
 * which is the one thing pinning exists to prevent.
 *
 * So: no leading zeros (npm resolves `2026.08.18` to `2026.8.18`, and the
 * recorded string would not name the code that ran), no empty prerelease
 * identifiers, no build metadata (`1.2.3+build` also installs `1.2.3`), and
 * numeric segments within what semver can represent.
 */
function isExactVersion(value) {
  if (typeof value !== 'string') return false;
  const match = VERSION_SHAPE.exec(value);
  if (!match) return false;

  for (const segment of [match[1], match[2], match[3]]) {
    if (segment.length > 1 && segment.startsWith('0')) return false;
    if (!Number.isSafeInteger(Number(segment))) return false;
  }

  if (match[4] !== undefined) {
    for (const identifier of match[4].split('.')) {
      if (identifier === '') return false;
      const numeric = /^\d+$/.test(identifier);
      if (numeric && identifier.length > 1 && identifier.startsWith('0')) return false;
    }
  }
  return true;
}

/** Hyphen last, so it cannot be read as a character range. */
const PACKAGE_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;

/** Names npm reserves outright, whatever their shape. */
const RESERVED_PACKAGE_NAMES = ['node_modules', 'favicon.ico'];

/**
 * An ordinary registry package name, scoped or not.
 *
 * A security control rather than tidiness: `npm install` also accepts git URLs,
 * tarball URLs and filesystem paths, any of which installs code that no pinned
 * version describes. Kept in step with npm's own rules — 214 characters, no
 * leading dot or underscore, lowercase, and the two reserved names — so that a
 * bad cohort entry is rejected here rather than by npm mid-sweep.
 */
function isPackageName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 214) {
    return false;
  }
  const bare = value.startsWith('@') ? value.slice(value.indexOf('/') + 1) : value;
  if (bare.startsWith('.') || bare.startsWith('_')) return false;
  if (RESERVED_PACKAGE_NAMES.includes(value.toLowerCase())) return false;
  return PACKAGE_NAME.test(value);
}

/**
 * A bin *name* as the package declares it — the key looked up in the manifest's
 * `bin` map, not a path.
 *
 * It constrains what a reviewer can commit and keeps the name boring. It is NOT
 * what keeps the resolved path inside the package: the value joined onto that
 * path comes from the third-party manifest, so containment has to be checked
 * where the join happens.
 */
const BIN_NAME = /^[A-Za-z0-9._-]+$/;

/** Ids appear in committed JSON and as labels, so they stay boring. */
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBinName(value) {
  // "." and ".." pass the character class and mean something else entirely.
  return isText(value) && value !== '.' && value !== '..' && BIN_NAME.test(value);
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

    // Object.hasOwn, because TARGET_SHAPES["__proto__"] is Object.prototype:
    // truthy, so a bare lookup passes this guard and then throws a TypeError
    // from inside the validator instead of reporting a bad cohort file.
    const shape =
      typeof target.kind === 'string' && Object.hasOwn(TARGET_SHAPES, target.kind)
        ? TARGET_SHAPES[target.kind]
        : undefined;
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
      if (!isPackageName(target.package)) {
        throw new Error(
          `${named}: package must be a plain npm package name, got ${JSON.stringify(target.package)}. Git URLs, tarball URLs and file paths are refused — they would install code no pinned version describes.`,
        );
      }
      if (!isExactVersion(target.version)) {
        throw new Error(
          `${named}: version must be an exact version like "1.2.3", got ${JSON.stringify(target.version)}. Ranges and dist-tags let an upstream release change the numbers and the executed code with no review.`,
        );
      }
      if (!isBinName(target.bin)) {
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

/**
 * Build a probe function from a library module.
 *
 * The library is injected rather than imported so the CLI can probe through the
 * built `dist/` — the same code path a user gets — while the tests probe through
 * `src/` with no build step. One implementation either way, and no environment
 * variable deciding which one runs.
 */
export function createProbe(lib) {
  return async function probe(target, opts = {}) {
    if (target.kind !== 'local') {
      // Reaching an npm target means installing it first, which is the next
      // task. Saying so beats spawning a bin that is not on this machine and
      // recording the resulting ENOENT as though the server were at fault.
      throw new Error(
        `Cannot probe npm target ${JSON.stringify(target.id)} yet: nothing is installed. ` +
          'Installation is added in the scanner CLI.',
      );
    }

    // Parse argv before constructing the transport. Inside the transport an
    // unbalanced quote becomes a transport error, which is indistinguishable
    // from a server going dark — and its message quotes the whole command line
    // back, credentials included. Failing here instead attributes our own bug
    // to us and says nothing about the server.
    let argv;
    try {
      argv = lib.tokenizeCommand(target.command);
    } catch {
      throw new Error(
        `command for ${JSON.stringify(target.id)} could not be parsed as argv ` +
          '(unbalanced quoting). The command is omitted here because it can carry credentials.',
      );
    }
    if (argv.length === 0) {
      throw new Error(`command for ${JSON.stringify(target.id)} is empty.`);
    }

    const transport = new lib.StdioTransport(target.command);
    try {
      return await lib.runChecks(transport, { timeoutMs: opts.timeoutMs });
    } finally {
      // Always: a leaked child process would hold the sweep open, and on a
      // cohort of servers that is a runner that never finishes.
      await transport.close();
    }
  };
}

/**
 * A committed reason is capped: the field is free text, and an unbounded
 * message means an unbounded diff on a file people read in a browser.
 */
const MAX_REASON = 300;

function cap(text) {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}… (truncated)` : text;
}

/**
 * Describe anything that was thrown, in text that is safe to commit.
 *
 * Two rules, both learned the hard way. Never serialise the thrown *value*:
 * `unreachable` is the one field the aggregator's allow-list cannot look
 * inside, so an object carrying an `Exchange` — headers, tokens — would go
 * straight into a public file. And never throw: this runs inside the catch
 * handler that keeps the sweep alive, so a value that resists serialisation
 * (a circular object, a BigInt) would discard every verdict already collected.
 */
function describeError(err) {
  let text;
  try {
    text = err instanceof Error ? err.message : `${typeof err} thrown: ${String(err)}`;
  } catch {
    // A getter or toString that throws. All we can honestly report is that.
    text = 'unprintable value thrown';
  }
  if (typeof text !== 'string') text = 'unprintable value thrown';
  return cap(text);
}

/**
 * What the index calls this target, and which release it names.
 *
 * A local target is named by its id, never by its command. The command is a
 * developer's own command line: absolute paths under their home directory, and
 * whatever `--api-key` they passed. Local targets are refused in the published
 * cohort, but the flag that allows one is exactly the flag a maintainer would
 * use before committing a snapshot by hand.
 */
function identify(target) {
  return target.kind === 'npm'
    ? { package: target.package, version: target.version }
    : { package: `local:${target.id}`, version: 'local' };
}

/**
 * A row for a target that could not be measured.
 *
 * Every count is zero rather than absent: the aggregator only ever sums rows
 * where `unreachable === null`, and a row that mixed a reason with real-looking
 * counts would be an invitation to read one of them by mistake.
 */
function unmeasured(target, reason) {
  return {
    id: target.id,
    ...identify(target),
    transport: 'stdio',
    ready: false,
    errorCount: 0,
    warningCount: 0,
    sdkErrors: 0,
    applicationErrors: 0,
    failedRules: [],
    unreachable: reason,
  };
}

/**
 * Reduce a full run report to the verdict row the index publishes.
 *
 * Verdicts only. The report carries `evidence` — the wire traffic behind each
 * finding, headers included — and none of it belongs in a file committed to a
 * public repository. This function is the narrow point where that is decided,
 * and `parseRunSnapshot` refuses anything it lets through by mistake.
 */
export function toResult(target, report) {
  const crashed = report.outcomes.filter((outcome) => outcome.crashed);
  if (crashed.length > 0) {
    // A crashed rule is a defect in this tool. Publishing a percentage derived
    // from a partial run would hide it behind a plausible-looking number.
    throw new Error(
      `Rule(s) crashed while probing ${JSON.stringify(target.id)}: ` +
        crashed.map((outcome) => outcome.rule.id).join(', '),
    );
  }

  if (report.unreachable) return unmeasured(target, report.unreachable);

  // A run that lost some probes and not others. Every rule treats an
  // unanswered probe as telling it nothing and reports no finding, so a server
  // that died partway through would otherwise arrive here with zero errors and
  // be published as ready off a fraction of the ruleset.
  if (report.incomplete) {
    const { failed, probes, reason } = report.incomplete;
    return unmeasured(
      target,
      `incomplete: ${failed} of ${probes} probes got no answer (${cap(reason)})`,
    );
  }

  const errors = report.findings.filter((finding) => finding.severity === 'error');
  return {
    id: target.id,
    ...identify(target),
    transport: 'stdio',
    ready: report.ready,
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    // The split the whole project exists to make: an SDK upgrade fixes these,
    // whereas the server's own author has to act on those.
    sdkErrors: errors.filter((finding) => finding.remediation === 'sdk').length,
    applicationErrors: errors.filter((finding) => finding.remediation === 'application')
      .length,
    failedRules: [...new Set(errors.map((finding) => finding.ruleId))].sort(),
    unreachable: null,
  };
}

/**
 * Probe every target in order and return one snapshot.
 *
 * Sequential on purpose: the cohort is small, and a runner probing several
 * servers at once produces timings — and timeouts — that nobody can reproduce.
 */
export async function scanTargets(targets, opts) {
  const now = opts.now ?? (() => new Date());
  const results = [];

  for (const target of targets) {
    let report;
    try {
      report = await opts.probe(target, { timeoutMs: opts.timeoutMs });
    } catch (err) {
      // One target's failure never aborts the sweep — the other servers'
      // verdicts are still worth having. The reason names the probe so a row
      // caused by our own spawn failure cannot be misread as a server that
      // went dark.
      results.push(unmeasured(target, `probe failed: ${describeError(err)}`));
      continue;
    }
    // Deliberately outside the catch: toResult throws only for a crashed rule,
    // and that must stop the run rather than become another unreachable row.
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
