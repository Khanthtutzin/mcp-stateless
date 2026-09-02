import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The weekly index workflow's credential split, asserted rather than reviewed.
 *
 * The whole security argument of the compliance index is one sentence: the job
 * that executes third-party code holds no credentials, and the job that holds a
 * write credential executes no third-party code. That property lives in YAML,
 * which nothing else in this repository checks, and it is exactly the kind of
 * thing a well-meaning edit undoes — moving one step into the wrong job, or
 * adding a cache to speed things up.
 *
 * Parsed by splitting on the job keys rather than with a YAML library, because
 * the package has no runtime dependencies and this is not worth a dev one.
 */
const WORKFLOW = fileURLToPath(
  new URL('../.github/workflows/index.yml', import.meta.url),
);

const text = readFileSync(WORKFLOW, 'utf8');
const scanAt = text.indexOf('\n  scan:');
const commitAt = text.indexOf('\n  commit:');

/**
 * Comments are stripped before the negative assertions run.
 *
 * Otherwise a comment *explaining* why we avoid something satisfies the
 * assertion that we avoid it. This file's first run failed exactly that way, on
 * a comment naming `git diff --quiet` in order to say we do not use it.
 */
function stripComments(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const scan = stripComments(text.slice(scanAt, commitAt));
const commit = stripComments(text.slice(commitAt));

describe('the weekly index workflow', () => {
  it('has both jobs, in the order the split depends on', () => {
    // If this fails, every other assertion here is inspecting the wrong text.
    expect(scanAt).toBeGreaterThan(-1);
    expect(commitAt).toBeGreaterThan(scanAt);
    expect(commit).toMatch(/needs:\s*scan/);
  });

  it('never runs on a schedule in a fork', () => {
    expect(scan).toMatch(/if:\s*github\.repository == 'Khanthtutzin\/mcp-stateless'/);
  });

  it('serialises runs, because both jobs write to index/', () => {
    expect(text).toMatch(/concurrency:/);
    expect(text).toMatch(/cancel-in-progress:\s*false/);
  });
});

describe('the scan job runs third-party code, so it holds nothing', () => {
  it('declares no token permissions at all', () => {
    expect(scan).toMatch(/permissions:\s*\{\}/);
  });

  it('does not leave git credentials on disk', () => {
    expect(scan).toMatch(/persist-credentials:\s*false/);
  });

  it('does not write an npm cache a poisoned install could sit in', () => {
    expect(scan).not.toMatch(/cache:\s*npm/);
  });

  it('reads no secrets', () => {
    expect(scan).not.toMatch(/secrets\./);
  });

  it('cannot push, because it never configures a committer or calls git push', () => {
    expect(scan).not.toMatch(/git push/);
    expect(scan).not.toMatch(/git config/);
  });

  it('is bounded in time, so a hostile server cannot hold a runner open', () => {
    expect(scan).toMatch(/timeout-minutes:/);
    // A per-request timeout is not a ceiling on a target; the budget is.
    expect(scan).toMatch(/--budget/);
  });
});

describe('the commit job holds a write credential, so it runs no target code', () => {
  it('has exactly the permission it needs', () => {
    expect(commit).toMatch(/contents:\s*write/);
  });

  it('never scans, installs a target, or builds', () => {
    expect(commit).not.toMatch(/index:scan/);
    expect(commit).not.toMatch(/npm run build/);
    expect(commit).not.toMatch(/npm ci/);
  });

  it('interpolates nothing out of the snapshot into a shell command', () => {
    // The shape to avoid is `date="$(node -p 'require("./snapshot.json")…')"`:
    // command substitution still happens inside double quotes, so a field from
    // a file produced alongside third-party code would reach a command line in
    // the one job that can push.
    expect(commit).not.toMatch(/\$\([^)]*snapshot/);
    expect(commit).not.toMatch(/scannedAt/);
  });

  it('lets the aggregator build the run path from a validated date', () => {
    expect(commit).toMatch(/--runs-dir/);
  });

  it('checks for untracked files before deciding there is nothing to commit', () => {
    // `git diff --quiet index/` ignores the new, untracked run file.
    expect(commit).toMatch(/git status --porcelain/);
    expect(commit).not.toMatch(/git diff --quiet/);
  });
});

describe('the workflow file itself', () => {
  it('uses spaces only, since a tab is not valid YAML indentation', () => {
    expect(text).not.toMatch(/\t/);
  });

  it('pins every action to a major version', () => {
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/@v\d+$/);
  });
});
