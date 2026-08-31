import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadTargets } from '../scripts/scan-index.mjs';

const npmTarget = {
  kind: 'npm',
  id: 'example-server-a',
  label: 'server-a',
  package: '@example/server-a',
  version: '1.2.3',
  bin: 'server-a',
  transport: 'stdio',
};

const localTarget = {
  kind: 'local',
  id: 'fixture-legacy',
  label: 'fixture (legacy)',
  command: 'node test/fixtures/servers/stdio-server.mjs legacy',
};

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
