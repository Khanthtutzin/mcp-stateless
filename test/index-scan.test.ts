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

  it('accepts an exact prerelease version', () => {
    expect(loadTargets(file([{ ...npmTarget, version: '2.0.0-alpha.0' }]))).toHaveLength(
      1,
    );
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
    expect(() => loadTargets('not json')).toThrow(/JSON/);
  });

  it('rejects a target that is not an object', () => {
    for (const entry of [null, 'oops', 7]) {
      expect(() => loadTargets(file([entry]))).toThrow(/must be an object/);
    }
  });

  it('rejects duplicate ids', () => {
    expect(() => loadTargets(file([npmTarget, npmTarget]))).toThrow(/duplicate/i);
  });

  it('rejects an unknown kind', () => {
    expect(() => loadTargets(file([{ ...npmTarget, kind: 'docker' }]))).toThrow(/kind/);
  });
});

describe('loadTargets — the allow-list is an allow-list', () => {
  // Keys that are merely unknown, so a presence-only check cannot pass these.
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
    // Otherwise a local target could carry a version that is never honoured.
    expect(() =>
      loadTargets(file([{ ...localTarget, version: '1.0.0' }]), { allowLocal: true }),
    ).toThrow(/unexpected key/);
  });
});

describe('loadTargets — versions must be pinned', () => {
  it('rejects a range', () => {
    // A floating version lets an upstream release change both the numbers and
    // the code that gets executed, with no review.
    for (const version of ['^1.2.3', '~1.2.3', '>=1.0.0', '1.x', '*']) {
      expect(() => loadTargets(file([{ ...npmTarget, version }]))).toThrow(
        /exact version/,
      );
    }
  });

  it('rejects a dist-tag', () => {
    for (const version of ['latest', 'next', 'beta']) {
      expect(() => loadTargets(file([{ ...npmTarget, version }]))).toThrow(
        /exact version/,
      );
    }
  });

  it('rejects a version with build metadata that npm would not resolve exactly', () => {
    expect(() => loadTargets(file([{ ...npmTarget, version: '1.2' }]))).toThrow(
      /exact version/,
    );
  });
});

describe('loadTargets — a target may only name a registry package', () => {
  it('rejects anything npm would resolve outside the registry', () => {
    // `npm install` happily accepts git URLs, tarball URLs and file paths. Any
    // of them would bypass the pinned-version guarantee entirely — the cohort
    // would execute code no reviewer had pinned.
    const specs = [
      'github:evil/repo',
      'git+https://example.com/evil.git',
      'https://example.com/evil.tgz',
      'file:../evil',
      '../evil',
      '/etc/passwd',
      '@example/server-a/../../evil',
    ];
    for (const pkg of specs) {
      expect(() => loadTargets(file([{ ...npmTarget, package: pkg }]))).toThrow(
        /package/,
      );
    }
  });

  it('accepts ordinary scoped and unscoped names', () => {
    for (const pkg of ['@modelcontextprotocol/server-memory', 'my-server', 'a.b_c-d']) {
      expect(loadTargets(file([{ ...npmTarget, package: pkg }]))).toHaveLength(1);
    }
  });
});

describe('loadTargets — field shapes', () => {
  it('rejects a bin that is a path rather than a name', () => {
    // The bin name is joined onto an install directory; a path would escape it.
    for (const bin of ['../../evil', 'nested/cli.js', 'C:\\evil.exe', '']) {
      expect(() => loadTargets(file([{ ...npmTarget, bin }]))).toThrow(/bin/);
    }
  });

  it('rejects an id that is not a lowercase slug', () => {
    // Ids appear in committed JSON and as chart labels.
    for (const id of ['Example Server', 'a/b', '', 'ÜBER']) {
      expect(() => loadTargets(file([{ ...npmTarget, id }]))).toThrow(/id/);
    }
  });

  it('rejects a missing or empty label', () => {
    const { label: _label, ...withoutLabel } = npmTarget;
    expect(() => loadTargets(file([withoutLabel]))).toThrow(/label/);
    expect(() => loadTargets(file([{ ...npmTarget, label: '' }]))).toThrow(/label/);
  });

  it('rejects an empty note when one is given', () => {
    expect(() => loadTargets(file([{ ...npmTarget, note: '' }]))).toThrow(/note/);
  });

  it('rejects a transport other than stdio', () => {
    // Probing someone's hosted endpoint on a cron without their consent is not
    // something this project does.
    expect(() => loadTargets(file([{ ...npmTarget, transport: 'http' }]))).toThrow(
      /stdio/,
    );
  });

  it('rejects a local target without a command', () => {
    const { command: _command, ...withoutCommand } = localTarget;
    expect(() => loadTargets(file([withoutCommand]), { allowLocal: true })).toThrow(
      /command/,
    );
  });
});
