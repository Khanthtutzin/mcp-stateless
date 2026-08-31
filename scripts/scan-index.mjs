import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// --- Installing a pinned target --------------------------------------------

/**
 * Find the JS entry point for a package's declared bin.
 *
 * Resolved from the manifest rather than from `node_modules/.bin`, so the
 * server is spawned as `node <file>` and no platform shim is involved. The
 * repository already has hard-won code for Windows batch shims in
 * src/transport/spawn-plan.ts; not needing it here is simpler than reusing it.
 *
 * **The manifest is third-party input.** `binName` is pinned by a reviewer in
 * index/targets.json, but the path it maps to comes from the package that was
 * just downloaded — so `"bin": {"x": "../../../../evil.js"}` would otherwise
 * hand us a path outside the install directory to execute. Validating the name
 * upstream does nothing about that; containment has to be checked here, where
 * the join happens.
 */
export function resolveNpmBin(installDir, pkg, binName) {
  const packageDir = join(installDir, 'node_modules', ...pkg.split('/'));
  const manifestPath = join(packageDir, 'package.json');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the manifest for ${pkg}: ${err.message}`);
  }

  const bin = manifest?.bin;
  let declared;
  if (typeof bin === 'string') {
    // The string form names no bin at all, so npm uses the package's last
    // segment. Accepting it for any requested name would mean the pinned name
    // was never compared against what actually runs.
    const implied = pkg.startsWith('@') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
    if (implied !== binName) {
      throw new Error(
        `${pkg} declares a single unnamed bin, which npm installs as ${JSON.stringify(implied)}, ` +
          `but the cohort pins ${JSON.stringify(binName)}. Update the cohort or the package.`,
      );
    }
    declared = bin;
  } else if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    if (!Object.hasOwn(bin, binName)) {
      throw new Error(
        `${pkg} declares no bin named ${JSON.stringify(binName)}. ` +
          `Declared: ${Object.keys(bin).join(', ') || '(none)'}`,
      );
    }
    declared = bin[binName];
  } else {
    throw new Error(
      `${pkg} declares no bin named ${JSON.stringify(binName)}. Declared: (none)`,
    );
  }

  if (typeof declared !== 'string' || declared.length === 0) {
    throw new Error(
      `${pkg} bin ${JSON.stringify(binName)} must be a path string, got ${JSON.stringify(declared)}.`,
    );
  }

  // Containment. Compare resolved paths: `relative` starting with `..`, or
  // being absolute, both mean the target escaped. An absolute `declared` makes
  // `join` discard packageDir entirely, which this also catches.
  const entry = resolve(packageDir, declared);
  const inside = relative(resolve(packageDir), entry);
  if (inside === '' || inside.startsWith('..') || inside.split(sep).includes('..')) {
    throw new Error(
      `${pkg} bin ${JSON.stringify(binName)} resolves outside the package directory ` +
        `(${JSON.stringify(declared)}). Refusing to execute it.`,
    );
  }

  if (!existsSync(entry)) {
    throw new Error(
      `${pkg} bin ${JSON.stringify(binName)} points at ${JSON.stringify(declared)}, which does not exist.`,
    );
  }

  return entry;
}

/**
 * Install one pinned target into its own directory.
 *
 * `--ignore-scripts` is not negotiable: install scripts are the classic
 * supply-chain vector, and a server that cannot start without one is out of
 * scope for the index. The version is re-checked here because this function
 * takes a name and a version and hands them straight to a network install —
 * `loadTargets` is the boundary, but a boundary one call site can bypass is
 * not much of a boundary.
 */
export function installTarget(target, dir, options = {}) {
  const run = options.run ?? execFileSync;

  if (!isPackageName(target.package)) {
    throw new Error(
      `Refusing to install ${JSON.stringify(target.package)}: not a plain package name.`,
    );
  }
  if (!isExactVersion(target.version)) {
    throw new Error(
      `Refusing to install ${target.package}@${target.version}: not an exact version.`,
    );
  }

  const argv = [
    'npm',
    'install',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    '--prefix',
    dir,
    `${target.package}@${target.version}`,
  ];

  // On Windows `npm` is a batch shim, and since the fix for CVE-2024-27980
  // Node refuses to spawn a .cmd directly — the first real scan failed with
  // `spawnSync npm.cmd EINVAL` on all four targets. `planSpawn` is the
  // library's existing answer: resolve the executable ourselves via PATHEXT
  // and, for a shim, invoke cmd.exe with a command line we quote. Not
  // `shell: true`, which would reinterpret metacharacters.
  const plan = options.planSpawn
    ? options.planSpawn(argv)
    : { file: argv[0], args: argv.slice(1), windowsVerbatimArguments: false };

  run(plan.file, plan.args, {
    stdio: 'pipe',
    encoding: 'utf8',
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
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
  const install = lib.install ?? installTarget;

  return async function probe(target, opts = {}) {
    let command;
    let cleanup = () => {};

    if (target.kind === 'local') {
      command = target.command;
    } else {
      // Its own directory, removed afterwards whatever happens. Sharing one
      // would let two targets' dependency trees decide each other's versions,
      // and the point of the exercise is that each row names the code that ran.
      const dir = mkdtempSync(join(tmpdir(), `mcp-index-${target.id}-`));
      cleanup = () => rmSync(dir, { recursive: true, force: true });
      try {
        install(target, dir, { planSpawn: lib.planSpawn });
        command = `node "${resolveNpmBin(dir, target.package, target.bin)}"`;
      } catch (err) {
        cleanup();
        throw err;
      }
    }

    // Parse argv before constructing the transport. Inside the transport an
    // unbalanced quote becomes a transport error, which is indistinguishable
    // from a server going dark — and its message quotes the whole command line
    // back, credentials included. Failing here instead attributes our own bug
    // to us and says nothing about the server.
    let argv;
    try {
      argv = lib.tokenizeCommand(command);
    } catch {
      cleanup();
      throw new Error(
        `command for ${JSON.stringify(target.id)} could not be parsed as argv ` +
          '(unbalanced quoting). The command is omitted here because it can carry credentials.',
      );
    }
    if (argv.length === 0) {
      cleanup();
      throw new Error(`command for ${JSON.stringify(target.id)} is empty.`);
    }

    const transport = new lib.StdioTransport(command);
    try {
      return await withBudget(
        lib.runChecks(transport, { timeoutMs: opts.timeoutMs }),
        opts.budgetMs,
        target,
      );
    } finally {
      // Always: a leaked child process would hold the sweep open, and on a
      // cohort of servers that is a runner that never finishes.
      await transport.close();
      cleanup();
    }
  };
}

/**
 * Fail a target that outlasts its wall-clock budget.
 *
 * A per-request timeout is not a ceiling on a run: it applies once per probe,
 * so a server that accepts a connection and answers nothing costs the timeout
 * roughly twenty times over. On a weekly cron across a growing cohort that is
 * the difference between a run that finishes and one that is cancelled.
 *
 * Closing the transport in the caller's `finally` is what actually stops the
 * abandoned run: it fails every pending request immediately.
 */
function withBudget(work, budgetMs, target) {
  if (!budgetMs) return work;

  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `exceeded the ${budgetMs}ms budget for ${JSON.stringify(target.id)} before finishing.`,
          ),
        ),
      budgetMs,
    );
  });

  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
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
      report = await opts.probe(target, {
        timeoutMs: opts.timeoutMs,
        budgetMs: opts.budgetMs,
      });
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

// --- CLI -------------------------------------------------------------------

const USAGE = `Usage: node scripts/scan-index.mjs [options]

  --targets <file>   Cohort to scan (default: index/targets.json)
  --out <file>       Where to write the snapshot
                     (default: index/runs/<scanned date>.json)
  --lib <specifier>  Library to probe through (default: ../dist/index.js)
  --allow-local      Permit kind:"local" targets. Requires --out.
  --timeout <ms>     Per-request timeout (default: 20000)
  --budget <ms>      Wall-clock ceiling per target (default: 120000)
  --help             Print this and exit
`;

/**
 * Only this entry point touches the network or the filesystem.
 *
 * It probes through the built `dist/` by default — the same code a user
 * installs — while the tests probe through `src/`. `--lib` exists because CI
 * runs the suite before the build, so a test that hard-coded `dist/` would fail
 * on a clean checkout.
 */
async function cli(argv) {
  const { mkdirSync, renameSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { parseArgs } = await import('node:util');

  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        targets: { type: 'string', default: 'index/targets.json' },
        out: { type: 'string' },
        lib: { type: 'string', default: '../dist/index.js' },
        'allow-local': { type: 'boolean', default: false },
        timeout: { type: 'string', default: '20000' },
        budget: { type: 'string', default: '120000' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // A local target names a command on one developer's machine and is recorded
  // as `local:<id>`, which is not data anyone should read as a verdict on a
  // published server. --allow-local is exactly the flag someone would reach
  // for before committing a snapshot by hand, so it may not use the default
  // path into the committed run directory.
  if (values['allow-local'] && !values.out) {
    process.stderr.write(
      'Refusing to write a scan that may contain local targets into ' +
        'index/runs/. Pass --out to write it somewhere else.\n',
    );
    return 2;
  }

  const timeoutMs = positiveInteger(values.timeout, '--timeout');
  const budgetMs = positiveInteger(values.budget, '--budget');

  const targets = loadTargets(readFileSync(values.targets, 'utf8'), {
    allowLocal: values['allow-local'],
  });

  let lib;
  try {
    lib = await import(values.lib);
  } catch (err) {
    throw new Error(
      `Could not load the library from ${values.lib} (${err.message}). ` +
        'Run "npm run build" first, or pass --lib.',
    );
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const snapshot = await scanTargets(targets, {
    probe: createProbe(lib),
    timeoutMs,
    budgetMs,
    toolVersion: pkg.version,
    rulesetSize: lib.ALL_RULES.length,
  });

  const out = values.out ?? `index/runs/${snapshot.scannedAt.slice(0, 10)}.json`;
  mkdirSync(dirname(out), { recursive: true });

  // Written beside the target and renamed, for the same reason the aggregator
  // does it: writeFileSync truncates first, so a cancelled workflow could
  // leave a zero-byte file that every later run fails to parse.
  const temporary = `${out}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(temporary, out);

  const measured = snapshot.results.filter((r) => r.unreachable === null);
  const ready = measured.filter((r) => r.ready).length;
  process.stdout.write(
    `Wrote ${out}: ${ready}/${measured.length} ready` +
      `${measured.length === snapshot.results.length ? '' : `, ${snapshot.results.length - measured.length} not measurable`}` +
      ` across ${snapshot.results.length} targets\n`,
  );
  return 0;
}

function positiveInteger(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${flag} must be a positive whole number of milliseconds, got ${JSON.stringify(value)}.`,
    );
  }
  return n;
}

/**
 * True when this file was run directly rather than imported.
 *
 * Compared via realpath, exactly as scripts/aggregate-index.mjs and
 * src/cli/index.ts do it. The obvious version —
 * \`import.meta.url === \`file://\${process.argv[1]}\`\` — never matches on
 * Windows, where argv[1] is \`C:\\dir\\file.mjs\` and import.meta.url is
 * percent-encoded \`file:///C:/dir/file.mjs\`. The failure is silent: the script
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
      process.stderr.write(`scan-index failed: ${err.message}\n`);
      process.exitCode = 1;
    },
  );
}
