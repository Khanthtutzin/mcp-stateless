import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createProbe,
  installTarget,
  resolveNpmBin,
  scanTargets,
  type NpmTarget,
  type Target,
} from '../scripts/scan-index.mjs';
import { ALL_RULES } from '../src/rules/index.js';
import { runChecks } from '../src/run.js';
import { StdioTransport, tokenizeCommand } from '../src/transport/stdio.js';

/**
 * Install trees are built here rather than committed.
 *
 * A committed fixture would have to live under a directory called
 * `node_modules`, which `.gitignore` excludes at every level — the files would
 * be absent in CI while the suite passed locally. Generating them also makes a
 * hostile manifest a two-line variant instead of another committed package.
 */
let root: string;

/** Write one package into `<root>/<dir>/node_modules/<pkg>`. */
function install(
  dir: string,
  pkg: string,
  manifest: Record<string, unknown>,
  files: string[] = [],
) {
  const base = join(root, dir, 'node_modules', ...pkg.split('/'));
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'package.json'), JSON.stringify(manifest), 'utf8');
  for (const file of files) {
    const path = join(base, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'process.exit(0);\n', 'utf8');
  }
  return join(root, dir);
}

let plain: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-index-fixtures-'));
  plain = install(
    'plain',
    '@example/server-a',
    { name: '@example/server-a', version: '1.2.3', bin: { 'server-a': 'bin/cli.js' } },
    ['bin/cli.js'],
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveNpmBin — finding the entry point', () => {
  it('resolves a named bin from the manifest', () => {
    const resolved = resolveNpmBin(plain, '@example/server-a', 'server-a');
    expect(resolved.replace(/\\/g, '/')).toMatch(/@example\/server-a\/bin\/cli\.js$/);
  });

  it('says which bins exist when the requested name is not declared', () => {
    expect(() => resolveNpmBin(plain, '@example/server-a', 'nope')).toThrow(
      /declares no bin named "nope".*server-a/s,
    );
  });

  it('says so when the package is not installed', () => {
    expect(() => resolveNpmBin(plain, '@example/missing', 'x')).toThrow(
      /@example\/missing/,
    );
  });

  it('rejects a manifest whose bin points at a file that is not there', () => {
    // Spawning `node <missing file>` reports a module-not-found on stderr and
    // exits, which would be recorded as the server failing to start.
    const dir = install('ghost', '@example/ghost', {
      name: '@example/ghost',
      version: '1.0.0',
      bin: { ghost: 'bin/cli.js' },
    });
    expect(() => resolveNpmBin(dir, '@example/ghost', 'ghost')).toThrow(/does not exist/);
  });
});

describe('resolveNpmBin — the manifest is third-party input', () => {
  // The bin *name* is pinned by a reviewer in index/targets.json. The path it
  // maps to is not: that comes from the package we just downloaded.
  it('refuses a bin path that escapes the package directory', () => {
    const dir = install('escape', '@example/escapes', {
      name: '@example/escapes',
      version: '1.0.0',
      bin: { escapes: '../../../../evil.js' },
    });

    expect(() => resolveNpmBin(dir, '@example/escapes', 'escapes')).toThrow(
      /outside the package/,
    );
  });

  it('refuses an absolute bin path', () => {
    const dir = install('absolute', '@example/absolute', {
      name: '@example/absolute',
      version: '1.0.0',
      bin: { absolute: process.platform === 'win32' ? 'C:\\evil.js' : '/evil.js' },
    });

    expect(() => resolveNpmBin(dir, '@example/absolute', 'absolute')).toThrow(
      /outside the package/,
    );
  });

  it('accepts the string form only when it is the bin the reviewer pinned', () => {
    // A string `bin` ignores the declared name entirely, so without this the
    // pinned name would never be compared against what actually runs.
    const dir = install(
      'stringform',
      '@example/server-b',
      { name: '@example/server-b', version: '1.0.0', bin: 'bin/cli.js' },
      ['bin/cli.js'],
    );

    expect(resolveNpmBin(dir, '@example/server-b', 'server-b')).toContain('cli.js');
    expect(() => resolveNpmBin(dir, '@example/server-b', 'something-else')).toThrow(
      /single unnamed bin/,
    );
  });

  it('refuses a bin value that is not a string', () => {
    const dir = install('weird', '@example/weird', {
      name: '@example/weird',
      version: '1.0.0',
      bin: { weird: { nested: 'bin/cli.js' } },
    });
    expect(() => resolveNpmBin(dir, '@example/weird', 'weird')).toThrow(/must be a path/);
  });

  it('does not find bins on Object.prototype', () => {
    // `bin[binName]` finds `toString` on an empty map and hands a function to
    // the path logic. Both forms end up rejecting, so only the message
    // distinguishes them — and the wrong message sends a reviewer looking for a
    // malformed path instead of a bin that was never declared.
    const dir = install('proto', '@example/proto', {
      name: '@example/proto',
      version: '1.0.0',
      bin: {},
    });

    for (const name of ['toString', 'constructor', 'valueOf']) {
      expect(() => resolveNpmBin(dir, '@example/proto', name)).toThrow(
        new RegExp(`declares no bin named "${name}"`),
      );
    }
  });

  it('refuses a manifest that is not JSON', () => {
    const base = join(root, 'broken', 'node_modules', '@example', 'broken');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'package.json'), 'not json', 'utf8');
    expect(() => resolveNpmBin(join(root, 'broken'), '@example/broken', 'x')).toThrow(
      /manifest/,
    );
  });
});

describe('installTarget', () => {
  const target: NpmTarget = {
    kind: 'npm',
    id: 'example-server-a',
    label: 'server-a',
    package: '@example/server-a',
    version: '1.2.3',
    bin: 'server-a',
    transport: 'stdio',
  };

  function capture() {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return '';
    };
    return { calls, run };
  }

  it('installs exactly the pinned version, and nothing else', () => {
    const { calls, run } = capture();
    installTarget(target, '/tmp/x', { run });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain('@example/server-a@1.2.3');
  });

  it('never runs install scripts', () => {
    // The classic supply-chain vector, and a server that cannot start without
    // one is out of scope for the index.
    const { calls, run } = capture();
    installTarget(target, '/tmp/x', { run });
    expect(calls[0]!.args).toContain('--ignore-scripts');
  });

  it('installs into the directory it was given, not the working tree', () => {
    const { calls, run } = capture();
    installTarget(target, '/tmp/somewhere', { run });
    const args = calls[0]!.args;
    expect(args[args.indexOf('--prefix') + 1]).toBe('/tmp/somewhere');
  });

  it('refuses a target whose version is not pinned', () => {
    // Defence in depth: loadTargets is the boundary, but this function takes a
    // package name and a version and hands them to a network install.
    const { run } = capture();
    for (const version of ['latest', '^1.0.0', '1.x']) {
      expect(() =>
        installTarget({ ...target, version } as NpmTarget, '/tmp/x', { run }),
      ).toThrow(/exact version/);
    }
  });

  it('refuses a package name npm would resolve outside the registry', () => {
    // Same reasoning as the version check: this function hands its arguments
    // to a network install, and a git or tarball spec would fetch code that no
    // pinned version describes.
    const { run } = capture();
    for (const pkg of ['github:evil/repo', 'https://x/evil.tgz', '../evil', 'UPPER']) {
      expect(() =>
        installTarget({ ...target, package: pkg } as NpmTarget, '/tmp/x', { run }),
      ).toThrow(/plain package name/);
    }
  });

  it('spawns npm through the plan, not by name', () => {
    // The first real scan failed on all four targets with
    // `spawnSync npm.cmd EINVAL`: on Windows npm is a batch shim, and since
    // the fix for CVE-2024-27980 Node will not spawn a .cmd directly. planSpawn
    // is the library's existing answer and must actually be consulted.
    const { calls, run } = capture();
    const seen: string[][] = [];
    const planSpawn = (argv: string[]) => {
      seen.push(argv);
      return {
        file: 'C:\\Windows\\system32\\cmd.exe',
        args: ['/d', '/s', '/c', '"npm install"'],
        windowsVerbatimArguments: true,
      };
    };

    installTarget(target, '/tmp/x', { run, planSpawn: planSpawn as never });

    expect(seen[0]![0]).toBe('npm');
    expect(seen[0]).toContain('@example/server-a@1.2.3');
    expect(calls[0]!.cmd).toMatch(/cmd\.exe$/);
    expect(calls[0]!.args[0]).toBe('/d');
  });

  it('passes the plan verbatim flag through to the spawn', () => {
    // Without it cmd.exe re-quotes the line we already quoted.
    const opts: object[] = [];
    const run = (_cmd: string, _args: string[], o: object) => {
      opts.push(o);
      return '';
    };
    installTarget(target, '/tmp/x', {
      run,
      planSpawn: (() => ({
        file: 'cmd.exe',
        args: [],
        windowsVerbatimArguments: true,
      })) as never,
    });
    expect(opts[0]).toMatchObject({ windowsVerbatimArguments: true });
  });
});

describe('createProbe — the npm path', () => {
  const target: NpmTarget = {
    kind: 'npm',
    id: 'example-server-a',
    label: 'server-a',
    package: '@example/server-a',
    version: '1.2.3',
    bin: 'server-a',
    transport: 'stdio',
  };

  const STDIO_SERVER = fileURLToPath(
    new URL('./fixtures/servers/stdio-server.mjs', import.meta.url),
  );

  it('installs, resolves the bin, probes it, and removes the directory', async () => {
    const dirs: string[] = [];
    // A fake install that drops the compliant fixture in where the bin should
    // be, so the whole path runs without touching the network.
    const install = (t: Target, dir: string) => {
      dirs.push(dir);
      const base = join(dir, 'node_modules', '@example', 'server-a');
      mkdirSync(join(base, 'bin'), { recursive: true });
      writeFileSync(
        join(base, 'package.json'),
        JSON.stringify({ name: '@example/server-a', bin: { 'server-a': 'bin/cli.js' } }),
        'utf8',
      );
      // A .js file in a package with no "type" field is CommonJS, so no
      // top-level await. pathToFileURL, because a Windows path is not a URL.
      writeFileSync(
        join(base, 'bin', 'cli.js'),
        `process.argv[2] = 'modern';\n` +
          `const { pathToFileURL } = require('node:url');\n` +
          `import(pathToFileURL(${JSON.stringify(STDIO_SERVER)}).href).catch((err) => {\n` +
          `  process.stderr.write(String(err) + '\\n');\n` +
          `  process.exit(1);\n` +
          `});\n`,
        'utf8',
      );
    };

    const probe = createProbe({ runChecks, StdioTransport, tokenizeCommand, install });
    const snapshot = await scanTargets([target], {
      probe,
      timeoutMs: 5000,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    const result = snapshot.results[0]!;
    expect(result.unreachable).toBeNull();
    expect(result.ready).toBe(true);
    expect(result.package).toBe('@example/server-a');

    expect(dirs).toHaveLength(1);
    expect(existsSync(dirs[0]!)).toBe(false);
  });

  it('removes the directory even when the install fails', async () => {
    const dirs: string[] = [];
    const install = (_t: Target, dir: string) => {
      dirs.push(dir);
      throw new Error('npm exploded');
    };

    const probe = createProbe({ runChecks, StdioTransport, tokenizeCommand, install });
    const snapshot = await scanTargets([target], {
      probe,
      toolVersion: '0.0.0-test',
      rulesetSize: 1,
    });

    expect(snapshot.results[0]!.unreachable).toMatch(/npm exploded/);
    expect(dirs).toHaveLength(1);
    expect(existsSync(dirs[0]!)).toBe(false);
  });
});

describe('createProbe — a per-target budget', () => {
  it('gives up on a target that outlasts its budget', async () => {
    // Per-request timeouts multiply: a server that accepts a connection and
    // answers nothing costs timeoutMs once per probe, so a weekly runner needs
    // a wall-clock ceiling per target rather than only a per-request one.
    const target: Target = {
      kind: 'local',
      id: 'slow',
      label: 'slow',
      command: 'node --eval "setInterval(() => {}, 1000)"',
    };

    const probe = createProbe({ runChecks, StdioTransport, tokenizeCommand });
    const started = Date.now();
    const snapshot = await scanTargets([target], {
      probe,
      timeoutMs: 60_000,
      budgetMs: 1500,
      toolVersion: '0.0.0-test',
      rulesetSize: ALL_RULES.length,
    });

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(snapshot.results[0]!.unreachable).toMatch(/budget/i);
    expect(snapshot.results[0]!.ready).toBe(false);
  });
});

/**
 * The CLI is exercised by running it, not by importing it.
 *
 * Task 2 shipped a CLI whose direct-invocation check could never match on
 * Windows: the script ran, did nothing, and exited 0, while every unit test
 * passed because they only touched the pure functions. Spawning is the only
 * thing that would have caught it.
 */
describe('the scanner CLI', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/scan-index.mjs', import.meta.url));
  const REPO = fileURLToPath(new URL('..', import.meta.url));

  const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const TSC = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );

  beforeAll(() => {
    // CI runs `npm test` before `npm run build`, and dist/ is gitignored, so
    // on a clean checkout it is simply not there. Building it here keeps the
    // CLI exercising the code a user actually installs.
    if (!existsSync(DIST)) {
      const built = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], {
        cwd: REPO,
        encoding: 'utf8',
      });
      if (built.status !== 0) {
        throw new Error(`could not build dist/: ${built.stdout}${built.stderr}`);
      }
    }
  }, 120_000);

  function run(args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }

  it('runs at all, rather than exiting 0 having done nothing', () => {
    const { status, stdout, stderr } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout + stderr).toMatch(/--targets/);
  });

  it('reports a usage error for an unknown flag instead of ignoring it', () => {
    const { status, stderr } = run(['--nonsense']);
    expect(status).toBe(2);
    expect(stderr).toMatch(/nonsense/);
  });

  it('scans a local cohort into a snapshot file', () => {
    const targets = join(root, 'cohort.json');
    const out = join(root, 'snapshot.json');
    const server = fileURLToPath(
      new URL('./fixtures/servers/stdio-server.mjs', import.meta.url),
    );
    writeFileSync(
      targets,
      JSON.stringify({
        schemaVersion: 1,
        targets: [
          {
            kind: 'local',
            id: 'fixture-modern',
            label: 'fixture (modern)',
            command: `node "${server}" modern`,
          },
        ],
      }),
      'utf8',
    );

    const { status, stdout, stderr } = run([
      '--targets',
      targets,
      '--out',
      out,
      '--allow-local',
      '--timeout',
      '5000',
    ]);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(stdout).toMatch(/1\/1 ready/);

    const snapshot = JSON.parse(readFileSync(out, 'utf8'));
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.results[0].ready).toBe(true);
    // The whole point of the format: verdicts, never traffic.
    expect(readFileSync(out, 'utf8')).not.toContain('evidence');
    expect(readFileSync(out, 'utf8')).not.toContain('requestHeaders');
  });

  it('refuses to write a local-target scan into the committed run directory', () => {
    // --allow-local is exactly the flag a maintainer would reach for before
    // committing a snapshot by hand, and `local:<id>` rows are not real data.
    const targets = join(root, 'cohort.json');
    const { status, stderr } = run(['--targets', targets, '--allow-local']);
    expect(status).toBe(2);
    expect(stderr).toMatch(/--out/);
  });

  it('writes through a temporary file and renames it', () => {
    // writeFileSync truncates before writing, so a run killed inside that
    // window — a cancelled workflow, a timeout-minutes kill — would leave a
    // zero-byte snapshot that every later run fails to parse. Occupying the
    // temporary path is the only way to observe from outside that the write
    // goes through it.
    const targets = join(root, 'cohort.json');
    const out = join(root, 'blocked.json');
    mkdirSync(`${out}.tmp`, { recursive: true });

    const { status, stderr } = run([
      '--targets',
      targets,
      '--out',
      out,
      '--allow-local',
      '--timeout',
      '5000',
    ]);

    expect(status).toBe(1);
    expect(stderr).toMatch(/blocked\.json\.tmp|EISDIR|EPERM|EACCES/);
    expect(existsSync(out)).toBe(false);
  });

  it('leaves no temporary file behind on success', () => {
    const targets = join(root, 'cohort.json');
    const out = join(root, 'clean.json');
    const { status } = run([
      '--targets',
      targets,
      '--out',
      out,
      '--allow-local',
      '--timeout',
      '5000',
    ]);
    expect(status).toBe(0);
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it('names the file it could not read, rather than failing obscurely', () => {
    const { status, stderr } = run(['--targets', join(root, 'nope.json')]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/nope\.json/);
  });
});
