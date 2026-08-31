# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are permanent. A retired rule is removed from the registry but its
number is never reissued, so a `--skip` entry in your CI config can never
silently start suppressing a different check.

## [Unreleased]

### Added

- A weekly ecosystem compliance index: a curated, version-pinned cohort probed
  by CI, with an append-only history whose git log is the audit trail. The
  scanning job holds no credentials and the committing job runs no third-party
  code; only verdicts and rule ids are stored, never wire traffic. First data
  point: 0 of 4 official servers ready, 33 breaking findings, every one of them
  resolved by an SDK upgrade rather than a change to the server's own code.
- `planSpawn` is now exported. It resolves an executable through `PATHEXT` and
  routes Windows batch shims through `cmd.exe` with arguments it quotes itself,
  which anything spawning an MCP server on Windows needs.
- `--emit <format>:<file>`, repeatable. One probe renders any number of formats,
  so a CI job can have text on stdout, JSON for its outputs and SARIF for upload
  without probing the server three times. Files never receive ANSI escapes, and
  a malformed `--emit` fails before anything is spawned.
- `version` input on the GitHub Action, and the action now pins the CLI to the
  npm version it was released with. Previously `uses: …@v1` pinned the action
  but ran whatever npm considered latest.
- `test/cli.test.ts` — the CLI had no test coverage at all. Covers `--emit`,
  exit codes, `--fail-on never`, unknown rule ids and `--list-rules`.

### Fixed

- A run that could not be completed is no longer reported as ready. A server
  that answered the first probe and then stopped came back with zero findings
  and exit `0`, because every rule treats an unanswered probe as telling it
  nothing — a green verdict drawn from a fraction of the ruleset. Such a run is
  now `INCOMPLETE` in every format, carries an `incomplete` object in the JSON
  report, and exits `2` even under `--fail-on never`.
- Closing a transport while a run was still in flight raised an uncaught
  `write after end` and terminated the process. A write to an ended pipe fails
  asynchronously, so the `try`/`catch` around it never saw the error. Any
  caller with a timeout could hit this.

### Changed

- The Action probes **once** instead of three times. The JSON feeding
  `ready`/`errors`/`warnings` is now rendered from the same run as the text the
  user reads and the markdown posted to the step summary; against a flaky server
  those three could previously disagree.
- Release workflow maintains a moving major tag (`v1`) from 1.0.0 onward,
  excluding prereleases. Documented action examples pin an exact release until
  then, because `@v1` did not exist.

### Documentation

- An explicit statement of non-affiliation with the MCP project and Anthropic.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — a project guide covering the
  stack, the layer boundaries, the probe sequence, the workflows, and the
  questions a newcomer actually asks.

## [0.1.5] — 2026-08-18

First release published entirely by CI. No version-visible changes: cut to
confirm the trusted-publishing pipeline is repeatable rather than a one-off.

## [0.1.4] — 2026-08-18

### Changed

- Releases now publish through npm **trusted publishing** (OIDC), so every
  version from here carries a signed SLSA provenance attestation binding it to
  the workflow and commit that built it. No token exists to leak or rotate.

### Fixed

- `setup-node`'s `registry-url` wrote an `.npmrc` containing
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`. With the token removed
  for OIDC, that left a configured-but-empty credential, and npm reads any
  configured credential as "auth is handled" — it never attempted the OIDC
  exchange. Removing `registry-url` was necessary but not sufficient: the
  trusted publisher record had also never saved, because the first attempt was
  made from a browser session predating 2FA and npm rejected it silently.

## [0.1.3] — 2026-08-18

The first release to contain the fixes that came out of testing against a real
migrated server, rather than only against fixtures.

### Added

- [**A migration walkthrough**](docs/migration-walkthrough.md) taking a working
  server from 7 breaking findings to READY, with real output throughout: the
  full report, what each finding means, the actual diff, and an account of what
  the tool got wrong and what it still cannot tell you.
- Every rule declares `remediation: 'sdk' | 'application'` — whether an SDK
  upgrade resolves the finding or the author must act. The terminal, JSON and
  Markdown reports split their summaries on that line. Against a stock-SDK
  server nearly everything is SDK plumbing, and saying so keeps maintainers out
  of code they did not write.
- `.github/dependabot.yml`, and the package metadata npm requires for
  provenance (`repository`, `bugs`, `homepage`, `author`).

### Fixed

Five defects, every one found by contact with real software rather than by the
test suite — the fixtures had encoded the same assumptions as the rules.

- **Windows: `--stdio "npx ..."` failed with `spawn npx ENOENT`.** `npx` is a
  `.cmd` shim that Node cannot resolve without `shell: true` and, since the fix
  for CVE-2024-27980, refuses to spawn directly. The executable is now resolved
  through `PATHEXT` and batch shims are routed via `cmd.exe` with quoted
  arguments, keeping `shell: true` off so command metacharacters are still
  never interpreted. This made the tool unusable on Windows for most of the
  ecosystem, including the exact `npx` invocation the README documents.
- **The HTTP transport never sent `MCP-Protocol-Version`**, required by
  SEP-2243 on every modern POST. A real SDK v2 server rejected all 18 probes
  with `-32020` and seven rules fired on our own omission. The header is now
  mirrored from the request's `_meta` envelope rather than hardcoded, so a rule
  that deliberately sends an unsupported version still reaches the
  version-rejection path instead of tripping HeaderMismatch.
- **MCP001 checked `protocolVersions`** — the `DiscoverResult` field is
  `supportedVersions` — **and expected `serverInfo` at the top level**, where
  the schema does not define it. Both verified against the published schema.
- **MCP002 reported dual-era servers as NOT READY.** A server answering
  `server/discover` while still handling `initialize` is serving both eras, the
  migration path the SDK documents as the recommended first step. Now an
  advisory; only a legacy-only server is an error. `-32022` is also accepted
  alongside `-32601` as a valid rejection of `initialize`.
- **MCP009 blamed the server author** for something an SDK upgrade fixes, and
  probed `subscriptions/listen` with an invented parameter shape (`subscribe`
  where `SubscriptionFilter` defines `notifications`).
- **`bin` was silently stripped at publish time.** npm normalises the manifest
  more aggressively on publish than on pack, and rejected the `./` prefix on
  `./dist/cli/index.js` — removed, not rewritten. The published package would
  have installed cleanly with no working command. The release workflow now
  fails if npm reports any auto-correction.
- `--no-color` was documented in `--help` but rejected by the parser;
  `node:util.parseArgs` has no `--no-` negation. `NO_COLOR` is honoured too.

### Changed

- Vitest 2.1.9 → 3.2.7, clearing five development-scope advisories including a
  critical one. None ever reached users: the published package has zero runtime
  dependencies.
- README restructured for GitHub, and `PUSHING.md` / `SETUP.md` removed as
  spent scaffolding.

## [0.1.0] — 2026-08-18

Initial release. Checks a live MCP server against revision
[`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

### Added

- Dual-protocol live probe over **stdio** and **Streamable HTTP**, speaking both
  the 2026-07-28 stateless revision and pre-2026 stateful revisions so it can
  tell which one a server actually implements.
- **18 rules**, each tied to a specific changelog entry:
  - `MCP001` `server/discover` not implemented
  - `MCP002` still requires the `initialize` handshake
  - `MCP003` still uses the removed `Mcp-Session-Id` header
  - `MCP004` results missing required `resultType`
  - `MCP005` list results missing `ttlMs` / `cacheScope`
  - `MCP006` removed `ping` still implemented
  - `MCP007` removed `logging/setLevel` still implemented
  - `MCP008` removed `resources/subscribe` still implemented
  - `MCP009` `subscriptions/listen` missing despite advertised `listChanged`
  - `MCP010` removed HTTP GET stream endpoint still served
  - `MCP011` resource-not-found still returns `-32002`
  - `MCP012` protocol error codes not renumbered into the reserved range
  - `MCP013` rejects requests carrying the `_meta` protocol envelope
  - `MCP014` rejects the required `Mcp-Method` / `Mcp-Name` headers
  - `MCP015` declares deprecated Roots / Sampling / Logging capabilities
  - `MCP016` deprecated HTTP+SSE transport
  - `MCP017` `tools/list` ordering not deterministic
  - `MCP018` results do not identify the server via `_meta` `serverInfo`
- Four output formats: terminal, `--format json`, `--format sarif` for GitHub
  code scanning, and `--format markdown` for step summaries and PR comments.
- GitHub Action wrapper (`action.yml`).
- Programmatic API: `runChecks`, `StdioTransport`, `HttpTransport`.
- Zero runtime dependencies.
- Generated per-rule documentation under `docs/rules/`, with a CI check that
  keeps it in step with the rule sources.

[Unreleased]: https://github.com/Khanthtutzin/mcp-stateless/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.5
[0.1.4]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.4
[0.1.3]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.3
[0.1.0]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.0
