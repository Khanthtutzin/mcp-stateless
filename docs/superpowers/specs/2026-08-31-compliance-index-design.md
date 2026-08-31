# MCP compliance index — design

**Date:** 2026-08-31
**Status:** approved, not yet implemented

## Goal

Publish a weekly, reproducible measurement of how much of the MCP server
ecosystem has migrated to `2026-07-28`, and how that share changes over time.

The trend line is the asset. Anyone can run `mcp-stateless` against one server;
nobody else is positioned to say "12% of tracked servers were ready in September,
31% in December, and MCP005 is the single most common blocker". It is also the
project's own prioritisation signal: the rules servers fail most often are the
rules worth investing in.

## Non-goals

- **No per-server pages, no badges, no scorecards.** The headline is the cohort.
  Individual servers appear in a table because the aggregate would not be
  verifiable otherwise, not to grade anyone.
- **No unsolicited probing of hosted endpoints.** The initial cohort is npm
  packages run locally over stdio. An HTTP target is only ever added if its
  operator asks to be included. Scanning someone's production endpoint on a cron
  without permission is not a thing this project does.
- **No stored evidence.** See "What gets stored".
- **No backend.** No API, no database, no accounts. If this design ever appears
  to need one, that is a signal to stop and reconsider, not to add one.

## Decisions taken

| Question              | Decision                                                                       |
| --------------------- | ------------------------------------------------------------------------------ |
| What is it for?       | Ecosystem health tracker — aggregate headline, cohort table beneath            |
| Which servers?        | Curated JSON, exact pinned versions, additions by reviewed PR                  |
| Where does data live? | Committed under `index/` on the default branch; git history is the audit trail |
| How is it built?      | Zero-dependency Node script in `scripts/`, driven by its own workflow          |

## Architecture

```
index/targets.json ──► scripts/scan-index.mjs ──► index/runs/<date>.json
   (curated, pinned)      imports runChecks           (per-target verdicts)
                          from dist/index.js
                                  │
                                  ▼
                        scripts/aggregate-index.mjs ──► index/history.json
                        (pure: snapshot → row)            (append-only, one row per run)
                                                                │
                                                                ▼
                                                site/ imports both at build time
                                                → headline · trend · cohort table
```

The pure/impure split is the load-bearing boundary. `aggregate-index.mjs`
contains no I/O beyond its CLI entry point: its exported `summarise()` maps a run
snapshot to one history row and is unit-testable without a process or a socket.
`scan-index.mjs` owns installation, spawning and file writes, and stays thin.

This mirrors the existing rules/transport separation: the thing worth testing
does not touch the thing that touches the world.

## Components

### `index/targets.json`

The cohort definition. Adding, removing or bumping a target is a reviewed PR.

```jsonc
{
  "schemaVersion": 1,
  "targets": [
    {
      "kind": "npm",
      "id": "modelcontextprotocol-server-memory",
      "label": "server-memory",
      "package": "@modelcontextprotocol/server-memory",
      "version": "0.6.3", // exact, never a range
      "bin": "mcp-server-memory", // the bin NAME as declared by the package;
      // the scanner resolves it to a path after install
      "transport": "stdio",
      "note": "official reference server",
    },
  ],
}
```

**Two target kinds**, because the test suite must run offline:

- `"kind": "npm"` — the real cohort. Installed, then probed.
- `"kind": "local"` — `{ "command": "node test/fixtures/servers/stdio-server.mjs legacy" }`.
  Nothing is installed; the command is spawned as given. Used **only** by the
  integration test's temp targets file. The published `index/targets.json`
  contains no `local` targets, and the scanner refuses to write a snapshot
  containing one unless `--allow-local` is passed, so a stray fixture can never
  end up in real data.

Initial cohort: the four official `@modelcontextprotocol/*` servers already
measured by hand in the README. Exact versions are resolved with `npm view` at
implementation time — this spec deliberately does not guess them. The cohort
grows by PR from there.

Ranges are rejected by the scanner for `npm` targets, not just discouraged: a
floating version would let an upstream release change both the numbers and the
executed code without review.

### `scripts/scan-index.mjs`

Zero runtime dependencies, run with `node`. Responsibilities, in order:

1. Read and validate `targets.json`. Reject any non-exact version, and reject
   `local` targets unless `--allow-local` was passed.
2. For each `npm` target, into a fresh temp directory:
   `npm install --no-save --ignore-scripts <package>@<version>`.
   `--ignore-scripts` matters — install scripts are the classic supply-chain
   vector, and a server that cannot start without one is out of scope.
3. Resolve the installed bin name to a path (`local` targets skip straight to
   here with their command as given) and probe it via `StdioTransport` +
   `runChecks` imported from `dist/index.js` — the same code path users get.
4. Reduce each `RunReport` to a verdict record (below). Discard evidence.
5. Write `index/runs/<YYYY-MM-DD>.json`.

One target's failure never aborts the sweep.

Per-target wall-clock is bounded by `--budget` (default 120 s), **not** by
`--timeout`. An earlier draft of this section said otherwise and was wrong:
`--timeout` is per _request_, and a server that accepts a connection and then
answers nothing costs it once per probe — roughly twenty times over. The job
carries its own `timeout-minutes` as a backstop.

### `scripts/aggregate-index.mjs`

Exports `summarise(snapshot) → historyRow` (pure) and `parseRunSnapshot(text)`
(throws on bad shape). Its CLI entry appends one row to `index/history.json`.
The commit job calls the same `parseRunSnapshot`, so validation exists once.

Typed for consumers via a hand-written `scripts/aggregate-index.d.mts`, matching
the existing convention in `test/fixtures/servers/http-server.d.mts`.

### `.github/workflows/index.yml`

Weekly cron (Mondays 06:00 UTC) plus `workflow_dispatch`.
`concurrency: { group: index, cancel-in-progress: false }`.

**Two jobs, and the split is the security design:**

| Job      | `permissions`     | Does                                                                         |
| -------- | ----------------- | ---------------------------------------------------------------------------- |
| `scan`   | `{}` — none       | `npm ci`, `npm run build`, run the sweep, upload the snapshot as an artifact |
| `commit` | `contents: write` | Download the artifact, `parseRunSnapshot` it, aggregate, commit both files   |

The job that executes third-party code has **no `GITHUB_TOKEN`**, no npm cache
write, and no access to any secret. The job that holds a write credential never
executes target code — it only parses JSON it validates first. A compromised
upstream release finds nothing to steal and no way to reach the token.

### Site integration

> **Amended 2026-08-31**, after the site was rebuilt on Astro and Starlight —
> see [the documentation site design](2026-08-31-docs-site-design.md). The
> intent below is unchanged; three of the file names are not.
>
> - `site/vite.config.ts` no longer exists. The alias moves to
>   `vite.resolve.alias` inside `site/astro.config.ts`, which Astro passes
>   through to Vite. Same effect, same reasoning.
> - `site/src/App.tsx` and `site/src/components/Section.tsx` no longer exist.
>   The landing page is `site/src/pages/index.astro`, and its sections are
>   plain `<section class="band">` elements styled by `src/styles/landing.css`.
>   `IndexSection` should follow that pattern rather than being a React island:
>   the trend line and cohort table are static at build time and need no
>   client-side JavaScript.
> - `pages.yml`'s path filter has since been widened to cover `docs/**` too, so
>   the change there is to add `index/**` to the existing list rather than to
>   replace a one-line filter.

`pages.yml` gains `index/**` to its path filter, so a results commit redeploys
the page.

The site gets an `@index` alias to `../index` (plus `server.fs.allow` for dev),
so it imports the canonical JSON rather than a duplicated copy.

New `IndexSection`: headline stats, a hand-rolled inline SVG trend line (no
chart library — same reasoning as the hand-rolled ANSI), and the cohort table.
The table is the accessible source of truth; the chart is `aria-hidden` with a
one-sentence text summary beside it.

## Data contracts

### `index/runs/<date>.json`

```jsonc
{
  "schemaVersion": 1,
  "scannedAt": "2026-09-07T06:04:11.000Z",
  "toolVersion": "0.1.5",
  "rulesetSize": 18,
  "results": [
    {
      "id": "modelcontextprotocol-server-memory",
      "package": "@modelcontextprotocol/server-memory",
      "version": "0.6.3",
      "transport": "stdio",
      "ready": false,
      "errorCount": 9,
      "warningCount": 1,
      "sdkErrors": 8,
      "applicationErrors": 1,
      "failedRules": ["MCP001", "MCP002", "MCP004"],
      "unreachable": null, // or a reason string
    },
  ],
}
```

### `index/history.json`

Append-only, one row per run, small enough to import whole.

```jsonc
{
  "schemaVersion": 1,
  "rows": [
    {
      "date": "2026-09-07",
      "toolVersion": "0.1.5",
      "rulesetSize": 18,
      "cohortSize": 4,
      "measured": 4,
      "unreachable": 0,
      "ready": 0,
      "medianErrors": 8,
      "sdkErrors": 29,
      "applicationErrors": 4,
      "ruleFailureCounts": { "MCP001": 4, "MCP002": 4 },
    },
  ],
}
```

### What gets stored, and what does not

Verdicts, counts and rule ids — **never evidence**. Three reasons: republishing
other people's wire traffic in a public repo is rude, evidence would dwarf the
useful data, and the page can instead print the one `npx` command that
reproduces any row. The claim stays checkable without the project becoming an
archive of other projects' internals.

`toolVersion` and `rulesetSize` are recorded per row because **adding a rule
changes the numbers**. A trend line that silently redefines itself is exactly the
sort of thing this tool faults servers for, so the chart marks ruleset changes
and the surrounding copy says so.

## Error handling

| Case                              | Behaviour                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Target fails to install           | Recorded `unreachable: "install failed: …"`, excluded from denominators, sweep continues |
| Target installs but never answers | `runChecks` returns `UNREACHABLE`; recorded the same way and rendered "not measurable"   |
| Target answers, then stops        | `runChecks` sets `incomplete`; recorded `unreachable: "incomplete: N of M probes …"`     |
| A rule crashes                    | **Fails the run loudly.** That is a bug in the tool, and silence would hide it           |
| Snapshot fails `parseRunSnapshot` | `commit` job fails without committing; the previous data stays live                      |
| Zero targets measurable           | No history row is appended; the workflow fails. A row of zeroes would be a false datum   |

Unreachable targets are excluded from the percentage denominator and shown as
"not measurable", never as "failing" — the same principle as the CLI's refusal to
convert a launch failure into eighteen verdicts.

### Amendment (2026-08-31): a partial probe is not a verdict either

This section originally modelled two outcomes, "answers" and "never answers".
There is a third, and it is the dangerous one. Every rule treats a probe that
got no answer as telling it nothing and reports no finding, so a server that
replied correctly and then died came out of `runChecks` with zero errors and
`ready: true` — a green row in the index drawn from a fraction of the ruleset.
The realistic trigger is a server that crashes on the legacy `initialize` probe,
which is exactly the probe designed to provoke error paths.

`RunReport` therefore carries `incomplete: { probes, failed, reason }` whenever
some probes went unanswered and others did not, no run carrying it is `ready`,
and `toResult` files such a target as not measurable. Two consequences for this
design: the readiness denominator counts only fully answered runs, and a row's
`unreachable` reason may now begin `incomplete:`, which the site should render
as "not measurable" with the fraction shown rather than as a failure.

## Testing

| Test                           | Kind        | Covers                                                                                                 |
| ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------ |
| `test/index-aggregate.test.ts` | unit, pure  | empty cohort · all-unreachable · mixed severities · ruleset change · median of even counts             |
| `test/index-scan.test.ts`      | integration | scanner against the existing stdio fixtures (`modern` + `legacy`) via a temp targets file — no network |
| `parseRunSnapshot` cases       | unit        | missing fields, wrong `schemaVersion`, floating version strings rejected                               |
| site build                     | typecheck   | JSON shape matches what the components expect                                                          |

The integration test reuses the fixture servers, so the cohort format is
exercised on every `npm test` without installing anything.

## Security considerations

1. **Credential isolation** — the two-job split above. Non-negotiable.
2. **`--ignore-scripts`** on every install.
3. **Exact versions only**, enforced by the scanner.
4. **No npm cache write** in the `scan` job (a poisoned cache would persist).
5. **Accepted residual risk:** GitHub-hosted runners cannot easily block egress,
   so a malicious target could phone home from the scan job. It has no
   credentials and no repository write access, so the blast radius is a wasted
   runner minute. Documented rather than hidden.
6. **stdio only.** No HTTP target without its operator's consent.
7. **The resolved bin must stay inside the package.** The bin _name_ is pinned
   by a reviewer, but the path it maps to comes from the manifest of the package
   that was just downloaded — so `"bin": {"x": "../../../../evil.js"}` would
   otherwise hand us a path outside the install directory to execute.
   `resolveNpmBin` resolves and then asserts containment, rejects an absolute
   path, requires the file to exist, and accepts the string form of `bin` only
   when the package's last segment equals the pinned name — because the string
   form names no bin at all, so the pinned name would never be compared against
   what runs.
8. **Each target installs into its own directory**, removed afterwards whatever
   happens. A shared tree would let two targets' dependency resolution decide
   each other's versions, and the whole point is that each row names the code
   that actually ran.

## Success criteria

- `node scripts/scan-index.mjs` against a fixture targets file produces a
  snapshot that `parseRunSnapshot` accepts.
- `npm test` covers aggregation and the scanner without network access.
- The workflow completes, commits, and the site redeploys showing real numbers
  that match a hand-run of the CLI against one cohort member.
- The `scan` job's rendered permissions show no token.
- No new entry in the root package's `dependencies`.

## Future, explicitly out of scope now

Per-server pages and badges, self-serve submission, HTTP cohort members,
alerting a maintainer when their server regresses. Each is a separate spec, and
none is worth building before the index has produced a few months of rows.
