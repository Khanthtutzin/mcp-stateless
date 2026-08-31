import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseRunSnapshot } from '../scripts/aggregate-index.mjs';
import {
  createProbe,
  loadTargets,
  scanTargets,
  toResult,
  type Lib,
  type ScanOptions,
  type Target,
} from '../scripts/scan-index.mjs';
import { MCP001 } from '../src/rules/MCP001.js';
import { ALL_RULES } from '../src/rules/index.js';
import type { Finding } from '../src/rules/types.js';
import { runChecks, type RunReport } from '../src/run.js';
import { StdioTransport, tokenizeCommand } from '../src/transport/stdio.js';

const npmTarget = {
  kind: 'npm',
  id: 'example-server-a',
  label: 'server-a',
  package: '@example/server-a',
  version: '1.2.3',
  bin: 'server-a',
  transport: 'stdio',
} satisfies Target;

const localTarget = {
  kind: 'local',
  id: 'fixture-legacy',
  label: 'fixture (legacy)',
  command: 'node test/fixtures/servers/stdio-server.mjs legacy',
} satisfies Target;

function file(targets: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, targets, ...over });
}

describe('loadTargets — what a cohort may contain', () => {
  it('accepts an exact-versioned npm target', () => {
    expect(loadTargets(file([npmTarget]))).toHaveLength(1);
  });

  it('accepts the calendar versions the real cohort uses', () => {
    for (const version of ['2026.8.18', '2026.7.4']) {
      expect(loadTargets(file([{ ...npmTarget, version }]))).toHaveLength(1);
    }
  });

  it('accepts an exact prerelease version', () => {
    for (const version of ['2.0.0-alpha.0', '1.0.0-rc.1', '1.0.0-beta']) {
      expect(loadTargets(file([{ ...npmTarget, version }]))).toHaveLength(1);
    }
  });

  it('accepts an optional note', () => {
    expect(
      loadTargets(file([{ ...npmTarget, note: 'official reference server' }])),
    ).toHaveLength(1);
  });

  it('accepts a local target only when explicitly allowed', () => {
    expect(() => loadTargets(file([localTarget]))).toThrow(/--allow-local/);
    expect(loadTargets(file([localTarget]), { allowLocal: true })).toHaveLength(1);
  });

  it('rejects an empty cohort', () => {
    expect(() => loadTargets(file([]))).toThrow(/at least one/);
  });

  it('rejects a targets file from a future schema', () => {
    expect(() => loadTargets(file([npmTarget], { schemaVersion: 2 }))).toThrow(
      /schemaVersion/,
    );
  });

  it('rejects text that is not JSON', () => {
    expect(() => loadTargets('not json')).toThrow(/not valid JSON/);
  });

  it('rejects a target that is not an object', () => {
    for (const entry of [null, 'oops', 7]) {
      expect(() => loadTargets(file([entry]))).toThrow(/must be an object/);
    }
  });

  it('rejects duplicate ids', () => {
    expect(() => loadTargets(file([npmTarget, npmTarget]))).toThrow(/Duplicate target/);
  });

  it('rejects an unknown kind', () => {
    expect(() => loadTargets(file([{ ...npmTarget, kind: 'docker' }]))).toThrow(
      /unknown kind/,
    );
  });

  it('rejects a kind that collides with Object.prototype', () => {
    // TARGET_SHAPES["__proto__"] is Object.prototype — truthy, so a bare lookup
    // passes the "unknown kind" guard and then throws a TypeError from inside
    // the validator instead of reporting a bad cohort file.
    for (const kind of ['__proto__', 'constructor', 'toString', 'valueOf']) {
      expect(() => loadTargets(file([{ ...npmTarget, kind }]))).toThrow(/unknown kind/);
    }
  });
});

describe('loadTargets — the allow-list is an allow-list', () => {
  // Keys that are merely unknown, so a blacklist cannot catch these.
  it('rejects an unknown key at the root', () => {
    expect(() => loadTargets(file([npmTarget], { generatedAt: 'now' }))).toThrow(
      /unexpected key/,
    );
  });

  it('rejects an unknown key on an npm target', () => {
    expect(() => loadTargets(file([{ ...npmTarget, registry: 'http://evil' }]))).toThrow(
      /unexpected key/,
    );
  });

  it('rejects an npm-only key on a local target', () => {
    expect(() =>
      loadTargets(file([{ ...localTarget, version: '1.0.0' }]), { allowLocal: true }),
    ).toThrow(/unexpected key/);
  });

  it('rejects a local-only key on an npm target', () => {
    expect(() => loadTargets(file([{ ...npmTarget, command: 'node evil.js' }]))).toThrow(
      /unexpected key/,
    );
  });
});

describe('loadTargets — versions must be pinned to one immutable release', () => {
  // Assertions name the distinguishing phrase. The allow-list's error lists
  // every legal key, so a bare /version/ would also match an unknown-key error.
  const rejects = (version: unknown) =>
    expect(() => loadTargets(file([{ ...npmTarget, version }]))).toThrow(
      /must be an exact version/,
    );

  it('rejects a range', () => {
    for (const version of ['^1.2.3', '~1.2.3', '>=1.0.0', '1.x', '*', '1.2']) {
      rejects(version);
    }
  });

  it('rejects a dist-tag', () => {
    for (const version of ['latest', 'next', 'beta']) rejects(version);
  });

  it('rejects strings npm would resolve as a dist-tag despite looking numeric', () => {
    // npm-package-arg classifies these as type "tag", not "version", because
    // semver.validRange() is null for them — so they are legal tag names and a
    // publisher can repoint them at any time. That is exactly what pinning is
    // supposed to prevent.
    for (const version of ['1.2.3-.', '1.2.3-a.', '2026.8.18-.']) rejects(version);
  });

  it('rejects numeric segments beyond what semver can represent', () => {
    // Also parsed as a tag rather than a version.
    for (const version of ['9007199254740993.0.0', '18446744073709551616.0.0']) {
      rejects(version);
    }
  });

  it('rejects leading zeros, which npm resolves to a different version', () => {
    // 2026.08.18 installs 2026.8.18, so the committed provenance string would
    // not name the code that actually ran.
    for (const version of ['01.2.3', '2026.08.18', '1.2.03', '1.2.3-01']) {
      rejects(version);
    }
  });

  it('rejects build metadata', () => {
    // npm resolves 1.2.3+build to 1.2.3, so the recorded string again differs
    // from the installed release.
    for (const version of ['1.2.3+build', '1.2.3+.', '1.2.3-x+.']) rejects(version);
  });
});

describe('loadTargets — a target may only name a registry package', () => {
  const rejects = (pkg: unknown) =>
    expect(() => loadTargets(file([{ ...npmTarget, package: pkg }]))).toThrow(
      /must be a plain npm package name/,
    );

  it('rejects anything npm would resolve outside the registry', () => {
    // `npm install` accepts git URLs, tarball URLs and file paths. Any of them
    // installs code that no pinned version describes.
    for (const pkg of [
      'github:evil/repo',
      'git+https://example.com/evil.git',
      'https://example.com/evil.tgz',
      'file:../evil',
      '../evil',
      '/etc/passwd',
      '@example/server-a/../../evil',
    ]) {
      rejects(pkg);
    }
  });

  it('rejects names npm itself considers invalid', () => {
    // These pass a naive name regex but make npm-package-arg throw, so the
    // boundary would hand the failure to `npm install` instead of reporting it.
    for (const pkg of ['node_modules', 'favicon.ico', '---', '.hidden', '_private']) {
      rejects(pkg);
    }
  });

  it('rejects a name longer than npm permits', () => {
    rejects('a'.repeat(215));
  });

  it('rejects an uppercase name', () => {
    // New packages must be lowercase. Pinning this keeps the character class
    // from being widened without a decision.
    rejects('MyServer');
  });

  it('accepts ordinary scoped and unscoped names', () => {
    for (const pkg of ['@modelcontextprotocol/server-memory', 'my-server', 'a.b_c-d']) {
      expect(loadTargets(file([{ ...npmTarget, package: pkg }]))).toHaveLength(1);
    }
  });
});

describe('loadTargets — field shapes', () => {
  it('rejects a bin that is not a plain name', () => {
    for (const bin of ['../../evil', 'nested/cli.js', 'C:\\evil.exe', '', '..', '.']) {
      expect(() => loadTargets(file([{ ...npmTarget, bin }]))).toThrow(
        /must be a bin name/,
      );
    }
  });

  it('rejects an id that is not a lowercase slug', () => {
    for (const id of ['Example Server', 'a/b', '', 'ÜBER', '-leading']) {
      expect(() => loadTargets(file([{ ...npmTarget, id }]))).toThrow(
        /must be a lowercase slug/,
      );
    }
  });

  it('rejects a missing or blank label', () => {
    const { label: _label, ...withoutLabel } = npmTarget;
    expect(() => loadTargets(file([withoutLabel]))).toThrow(/is missing label/);
    for (const label of ['', '   ']) {
      expect(() => loadTargets(file([{ ...npmTarget, label }]))).toThrow(/label must be/);
    }
  });

  it('rejects a blank note when one is given', () => {
    for (const note of ['', '  ']) {
      expect(() => loadTargets(file([{ ...npmTarget, note }]))).toThrow(/note must be/);
    }
  });

  it('rejects a transport other than stdio', () => {
    // Probing someone's hosted endpoint on a cron without their consent is not
    // something this project does.
    expect(() => loadTargets(file([{ ...npmTarget, transport: 'http' }]))).toThrow(
      /transport must be "stdio"/,
    );
  });

  it('rejects a local target without a command', () => {
    const { command: _command, ...withoutCommand } = localTarget;
    expect(() => loadTargets(file([withoutCommand]), { allowLocal: true })).toThrow(
      /is missing command/,
    );
  });
});

describe('the committed cohort', () => {
  // Without this, a PR can break index/targets.json or slip a fixture into the
  // real cohort with a green suite; it would only fail in the weekly CI job.
  const cohortPath = fileURLToPath(new URL('../index/targets.json', import.meta.url));

  it('validates under the same rules as any other cohort file', () => {
    const targets = loadTargets(readFileSync(cohortPath, 'utf8'));
    expect(targets.length).toBeGreaterThan(0);
  });

  it('contains no local targets', () => {
    // Loaded without allowLocal, so a local target would have thrown above —
    // asserted explicitly because that is the property that matters.
    const targets = loadTargets(readFileSync(cohortPath, 'utf8'));
    expect(targets.every((t) => t.kind === 'npm')).toBe(true);
  });
});

const STDIO_SERVER = fileURLToPath(
  new URL('./fixtures/servers/stdio-server.mjs', import.meta.url),
);

function local(id: string, mode: 'legacy' | 'modern'): Target {
  return {
    kind: 'local',
    id,
    label: id,
    command: `node "${STDIO_SERVER}" ${mode}`,
  };
}

const dead: Target = {
  kind: 'local',
  id: 'dead',
  label: 'dead',
  command: 'node --eval "process.exit(1)"',
};

const probe = createProbe({ runChecks, StdioTransport, tokenizeCommand });

const sweep = (targets: Target[], over: Partial<ScanOptions> = {}) =>
  scanTargets(targets, {
    probe,
    timeoutMs: 5000,
    toolVersion: '0.0.0-test',
    rulesetSize: ALL_RULES.length,
    ...over,
  });

/** A complete RunReport, so a fake cannot silently drift from the real shape. */
function makeReport(over: Partial<RunReport> = {}): RunReport {
  return {
    target: 'fixture',
    transport: 'stdio',
    targetRevision: '2026-07-28',
    startedAt: '2026-08-31T00:00:00.000Z',
    durationMs: 1,
    outcomes: [],
    findings: [],
    errorCount: 0,
    warningCount: 0,
    ready: true,
    diagnostics: [],
    ...over,
  };
}

/**
 * A complete Finding — including the `evidence` that must never reach a
 * snapshot. Building it here is what lets the round-trip tests prove it is
 * dropped rather than merely absent.
 */
function makeFinding(over: Partial<Finding> & Pick<Finding, 'ruleId'>): Finding {
  return {
    severity: 'error',
    remediation: 'sdk',
    title: 'fixture finding',
    observed: 'something',
    expected: 'something else',
    fix: 'do the thing',
    specRef: 'https://example.invalid/spec',
    evidence: [
      {
        request: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        requestHeaders: { authorization: 'Bearer sk-live-EVIDENCE' },
        response: null,
        responseHeaders: {},
        timingMs: 1,
      },
    ],
    ...over,
  };
}

const error = (ruleId: string, remediation: 'sdk' | 'application') =>
  makeFinding({ ruleId, severity: 'error', remediation });

describe('scanTargets — verdicts, not evidence', () => {
  it('records a legacy server as not ready with its failing rules', async () => {
    const snapshot = await sweep([local('legacy', 'legacy')]);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.toolVersion).toBe('0.0.0-test');
    expect(snapshot.rulesetSize).toBe(ALL_RULES.length);
    expect(snapshot.results).toHaveLength(1);

    const result = snapshot.results[0]!;
    expect(result.id).toBe('legacy');
    expect(result.ready).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    expect(result.failedRules).toContain('MCP002');
    expect(result.unreachable).toBeNull();
  });

  it('records a compliant server as ready with no failing rules', async () => {
    const result = (await sweep([local('modern', 'modern')])).results[0]!;
    expect(result.ready).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.failedRules).toEqual([]);
    expect(result.unreachable).toBeNull();
  });

  it('splits errors by who has to fix them, and the parts sum to the whole', async () => {
    const result = (await sweep([local('legacy', 'legacy')])).results[0]!;
    expect(result.sdkErrors + result.applicationErrors).toBe(result.errorCount);
  });

  it('lists each failing rule once, in id order', () => {
    // Fed out of order on purpose. Asserting against a sort of the output
    // would hold however the output was ordered, and the legacy fixture
    // happens to emit ids ascending because rules run in id order.
    const result = toResult(
      local('legacy', 'legacy'),
      makeReport({
        findings: [
          error('MCP009', 'sdk'),
          error('MCP002', 'sdk'),
          error('MCP009', 'application'),
          error('MCP004', 'sdk'),
        ],
        errorCount: 4,
        ready: false,
      }),
    );

    expect(result.failedRules).toEqual(['MCP002', 'MCP004', 'MCP009']);
  });

  it('stores no evidence, so parseRunSnapshot accepts its own output', async () => {
    // The aggregator validates against an allow-list and names evidence keys
    // explicitly. Round-tripping here is what keeps wire traffic — headers,
    // tokens, request bodies — out of the committed index.
    const snapshot = await sweep([local('legacy', 'legacy')]);
    expect(() => parseRunSnapshot(JSON.stringify(snapshot))).not.toThrow();
  });

  it('stamps scannedAt from the injected clock', async () => {
    const snapshot = await sweep([local('modern', 'modern')], {
      now: () => new Date('2026-08-31T00:00:00.000Z'),
    });
    expect(snapshot.scannedAt).toBe('2026-08-31T00:00:00.000Z');
  });
});

describe('scanTargets — a target that cannot be measured', () => {
  it('marks a server that never answers as unreachable, not as failing', async () => {
    // Eighteen conformance failures against a process that exited immediately
    // would be an artefact of our own failure to connect.
    const result = (await sweep([dead], { timeoutMs: 2000 })).results[0]!;
    expect(result.unreachable).toBeTruthy();
    expect(result.ready).toBe(false);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.sdkErrors).toBe(0);
    expect(result.applicationErrors).toBe(0);
    expect(result.failedRules).toEqual([]);
  });

  it('continues the sweep after one target cannot be reached', async () => {
    const snapshot = await sweep([dead, local('modern', 'modern')], { timeoutMs: 2000 });
    expect(snapshot.results.map((r) => r.id)).toEqual(['dead', 'modern']);
    expect(snapshot.results[1]!.ready).toBe(true);
  });

  it('records a thrown probe as unreachable, saying it was the probe', async () => {
    const snapshot = await scanTargets([local('modern', 'modern')], {
      probe: () => Promise.reject(new Error('spawn ENOENT')),
      toolVersion: '0.0.0-test',
      rulesetSize: 1,
    });
    expect(snapshot.results[0]!.unreachable).toBe('probe failed: spawn ENOENT');
  });

  it('reports a non-Error throw readably rather than as "undefined"', async () => {
    const snapshot = await scanTargets([local('modern', 'modern')], {
      probe: () => Promise.reject('just a string'),
      toolVersion: '0.0.0-test',
      rulesetSize: 1,
    });
    expect(snapshot.results[0]!.unreachable).toBe(
      'probe failed: string thrown: just a string',
    );
  });
});

describe('scanTargets — a crashed rule is our bug, not a verdict', () => {
  it('refuses to produce a snapshot when a rule threw', async () => {
    // A real Rule, so this fake cannot drift out of shape unnoticed.
    const crashingProbe = () =>
      Promise.resolve(
        makeReport({
          outcomes: [{ rule: MCP001, findings: [], crashed: 'boom', durationMs: 1 }],
        }),
      );

    // Not swallowed as "unreachable": publishing a percentage derived from a
    // partial run would hide the defect behind a plausible number.
    await expect(
      scanTargets([local('modern', 'modern')], {
        probe: crashingProbe,
        toolVersion: '0.0.0-test',
        rulesetSize: 1,
      }),
    ).rejects.toThrow(/crashed/i);
  });
});

describe('createProbe', () => {
  it('closes the transport even when the run throws', async () => {
    let closed = 0;
    class FakeTransport {
      close() {
        closed += 1;
        return Promise.resolve();
      }
    }
    const failing = createProbe({
      runChecks: () => Promise.reject(new Error('boom')),
      StdioTransport: FakeTransport,
      tokenizeCommand,
    } as unknown as Lib);

    await expect(failing(local('modern', 'modern'))).rejects.toThrow('boom');
    expect(closed).toBe(1);
  });

  it('refuses an npm target until installation exists', async () => {
    // Task 5 adds the install step. Until then this must say so rather than
    // silently spawn something that is not there.
    await expect(
      probe({
        kind: 'npm',
        id: 'x',
        label: 'x',
        package: '@example/server-a',
        version: '1.2.3',
        bin: 'server-a',
        transport: 'stdio',
      }),
    ).rejects.toThrow(/npm target/i);
  });
});

describe('toResult', () => {
  const reachable = makeReport();

  const warning = makeFinding({ ruleId: 'MCP010', severity: 'warning' });

  it('counts only errors as blockers, never warnings', () => {
    // A warning does not block readiness, so a warning in failedRules would
    // show up on the site as a server that fails a rule it in fact passes.
    const result = toResult(
      local('modern', 'modern'),
      makeReport({ findings: [warning], warningCount: 1 }),
    );

    expect(result.ready).toBe(true);
    expect(result.warningCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.failedRules).toEqual([]);
    expect(result.sdkErrors).toBe(0);
  });

  it('names an npm target by its package and version', () => {
    expect(toResult(npmTarget, reachable)).toMatchObject({
      package: '@example/server-a',
      version: '1.2.3',
    });
  });

  it('never publishes a local target argv, which can carry secrets', () => {
    // The command is a developer's own command line: absolute paths, and
    // whatever --api-key they passed. `unreachable` is the only free-text
    // field in the schema, so the aggregator's allow-list cannot see inside
    // either — the fix has to be not putting it there.
    const secret: Target = {
      kind: 'local',
      id: 'fixture-legacy',
      label: 'fixture',
      command: 'node "C:/Users/me/secret servers/srv.mjs" --api-key=sk-live-DEADBEEF',
    };

    const row = toResult(secret, reachable);
    expect(JSON.stringify(row)).not.toContain('sk-live-DEADBEEF');
    expect(JSON.stringify(row)).not.toContain('secret servers');
    expect(row.package).toBe('local:fixture-legacy');
    expect(row.version).toBe('local');
  });
});

describe('toResult — who has to fix it', () => {
  // F2: the sum assertion alone is invariant under swapping the two
  // predicates, and a swap would invert the headline number on the site.
  it('counts sdk and application errors in the right direction', () => {
    const result = toResult(
      npmTarget,
      makeReport({
        findings: [
          error('MCP001', 'sdk'),
          error('MCP002', 'sdk'),
          error('MCP004', 'sdk'),
          error('MCP013', 'application'),
          makeFinding({
            ruleId: 'MCP010',
            severity: 'warning',
            remediation: 'application',
          }),
        ],
        errorCount: 4,
        warningCount: 1,
        ready: false,
      }),
    );

    expect(result.sdkErrors).toBe(3);
    expect(result.applicationErrors).toBe(1);
    expect(result.errorCount).toBe(4);
    expect(result.warningCount).toBe(1);
  });
});

describe('a run we could not complete is not a verdict', () => {
  it('records a server that dies partway as unmeasured, not as ready', async () => {
    // The server answers correctly and then exits. Every rule treats an
    // unanswered probe as telling us nothing, so the findings list is empty
    // and readiness would otherwise come out green off one probe in eighteen.
    const DIES = fileURLToPath(
      new URL('./fixtures/servers/dies-after.mjs', import.meta.url),
    );
    const snapshot = await sweep(
      [
        {
          kind: 'local',
          id: 'dies',
          label: 'dies',
          command: `node "${DIES}" 2 exit`,
        },
      ],
      { timeoutMs: 1000 },
    );

    const result = snapshot.results[0]!;
    expect(result.ready).toBe(false);
    expect(result.unreachable).toMatch(/incomplete/i);
    expect(result.errorCount).toBe(0);
    expect(result.failedRules).toEqual([]);
  });
});

describe('the snapshot schema holds for rows that were not measured', () => {
  // F4: unmeasured rows are a second object literal that the round-trip test
  // never saw, so a typo in any of their fields shipped silently.
  it('round-trips an unreachable row through parseRunSnapshot', async () => {
    const snapshot = await sweep([dead], { timeoutMs: 2000 });
    expect(snapshot.results[0]!.unreachable).toBeTruthy();
    expect(() => parseRunSnapshot(JSON.stringify(snapshot))).not.toThrow();
  });

  it('round-trips a mix of measured and unmeasured rows', async () => {
    const snapshot = await sweep([dead, local('legacy', 'legacy')], { timeoutMs: 2000 });
    const parsed = parseRunSnapshot(JSON.stringify(snapshot));
    expect(parsed.results).toHaveLength(2);
  });
});

describe('a thrown probe cannot smuggle data or stop the sweep', () => {
  const scan = (targets: Target[], probe: ScanOptions['probe']) =>
    scanTargets(targets, { probe, toolVersion: '0.0.0-test', rulesetSize: 1 });

  it('never serialises a thrown object into the reason', async () => {
    // F6: `unreachable` is the one free-text field in the schema, so the
    // aggregator's allow-list cannot inspect it. JSON.stringify of a rejection
    // would carry whatever the object held — including request headers.
    const leaky = {
      message: 'auth failed',
      exchange: { requestHeaders: { authorization: 'Bearer sk-live-TOKEN' } },
    };
    const snapshot = await scan([local('modern', 'modern')], () => Promise.reject(leaky));

    const reason = snapshot.results[0]!.unreachable!;
    expect(reason).not.toContain('sk-live-TOKEN');
    expect(reason).not.toContain('requestHeaders');
    expect(() => parseRunSnapshot(JSON.stringify(snapshot))).not.toThrow();
  });

  it('caps a very long reason instead of committing it whole', async () => {
    const snapshot = await scan([local('modern', 'modern')], () =>
      Promise.reject(new Error('x'.repeat(10_000))),
    );
    expect(snapshot.results[0]!.unreachable!.length).toBeLessThan(500);
  });

  it('survives a rejection that cannot be stringified', async () => {
    // F7: the reason was built inside the catch handler, so a value that threw
    // on serialisation escaped the loop and discarded every verdict already
    // collected — indistinguishable to a caller from the deliberate abort.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const value of [circular, 10n, undefined, null, Symbol('nope')]) {
      const snapshot = await scan([local('modern', 'modern')], () =>
        Promise.reject(value),
      );
      expect(snapshot.results).toHaveLength(1);
      expect(snapshot.results[0]!.unreachable).toMatch(/^probe failed: /);
    }
  });
});

describe('createProbe attributes our own bugs to us', () => {
  it('reports an unparseable command as a probe failure, without echoing it', async () => {
    // F8: an unbalanced quote is caught inside the transport and surfaces as a
    // transport error, which looks exactly like a server going dark — and the
    // transport's message quotes the whole command line back.
    const snapshot = await sweep(
      [
        {
          kind: 'local',
          id: 'malformed',
          label: 'malformed',
          command: "node 'C:/Users/me/tok en.mjs --key=sk-live-SECRET",
        },
      ],
      { timeoutMs: 1000 },
    );

    const reason = snapshot.results[0]!.unreachable!;
    expect(reason).toMatch(/^probe failed: /);
    expect(reason).toMatch(/argv|quot/i);
    expect(reason).not.toContain('sk-live-SECRET');
    expect(reason).not.toContain('tok en.mjs');
  });

  it('reports an empty command as a probe failure', async () => {
    const snapshot = await sweep(
      [{ kind: 'local', id: 'blank', label: 'blank', command: '   ' }],
      { timeoutMs: 1000 },
    );
    expect(snapshot.results[0]!.unreachable).toMatch(/^probe failed: /);
  });
});
