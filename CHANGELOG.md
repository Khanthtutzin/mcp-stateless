# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Rule ids are permanent. A retired rule is removed from the registry but its
number is never reissued, so a `--skip` entry in your CI config can never
silently start suppressing a different check.

## [Unreleased]

### Fixed

- A correctly migrated server that advertises `listChanged` could never be
  `READY`. A working `subscriptions/listen` is never answered: the server sends
  `notifications/subscriptions/acknowledged`, tagged with the request id, and
  holds the stream open. MCP009 waited for a response and timed out, and
  since 0.2.0 any unanswered probe makes a run `INCOMPLETE`, so the official
  2.1.0 SDK served through `serveStdio` came back `INCOMPLETE` rather than
  `READY`. Both transports now treat the acknowledgement as the answer. A
  server that stays silent is still unanswered. The fixtures had answered
  `subscriptions/listen` like an ordinary request, which is why no test
  caught it; they now hold it open the way the SDK does.

### Added

- **MCP021** (error): tasks still served from the core protocol rather than the
  `io.modelcontextprotocol/tasks` extension (Major change 6, SEP-2663).
  Reports `tasks/list` and `tasks/result` answering a 2026-07-28 request, and
  a core `capabilities.tasks` in `server/discover`: an error when the
  extension is not advertised, a warning when both are. Also warns when
  `tasks/get` is served with nothing advertised. Capabilities are read from
  `server/discover` only, so a dual-era server's 2025-11-25 `initialize`
  answer is not held against it. Calibrated against the official SDKs: caught
  on a 1.30.1 server with tasks, silent on 2.1.0. (#2)

### Documentation

- The README and docs site are titled "MCP Stateless Check", matching the
  Marketplace listing, which the README and the CI guide now link to. The
  repository, the npm package and the `mcp-stateless` command are unchanged.

## [0.3.1] — 2026-09-27

### Changed

- The npm package's homepage now points at the docs site rather than the
  GitHub README.
- The Action's display name is now "MCP Stateless Check", so it can be listed
  on GitHub Marketplace: a GitHub organization already holds the name
  `mcp-stateless`. Nothing else changes: workflows still reference
  `Khanthtutzin/mcp-stateless@<version>`.

## [0.3.0] — 2026-09-27

### Added

- **MCP019** (warning, HTTP): the authorization server does not advertise
  RFC 9207 `iss` support (SEP-2468). For a server that publishes OAuth
  Protected Resource Metadata, it follows the spec's discovery order — the
  401 challenge's `resource_metadata`, then the path-inserted and root
  well-known URIs, then RFC 8414 and both OpenID Connect Discovery forms for
  each listed authorization server — and warns when
  `authorization_response_iss_parameter_supported` is absent or not `true`.
  Metadata inspection only: no authorization flow, and your `--header` values
  are never sent to the hosts the metadata names. A server without OAuth
  metadata is not affected. (#3)
- **MCP020** (warning, HTTP): an authorization server offers only deprecated
  Dynamic Client Registration (Deprecated 4). It warns when the metadata
  advertises `registration_endpoint` without
  `client_id_metadata_document_supported: true`. An authorization server with
  neither is relying on pre-registration and is not reported. Shares MCP019's
  discovery, cached per run, so the two rules together make the same requests
  as one. (#4)
- Compliance index rows record `toolCommit`, the full commit id of the checker
  that produced them. `toolVersion` comes from `package.json`, so a scan from
  `main` between releases carried the last release's number while running
  newer rules. The field is optional, so rows written before it stay valid,
  and it is validated as 40 lowercase hex characters, because it comes from
  the job that runs third-party code.

### Changed

- **MCP005 now checks all five `CacheableResult` methods**, not only
  `tools/list`: `prompts/list`, `resources/list`, `resources/templates/list`
  and `resources/read` (on the first URI the server lists). A server whose
  `tools/list` was compliant could previously pass while breaking caching on
  the other four. Methods a server does not implement are skipped. Findings
  stay one per missing field, with every affected method named in `observed`
  and included as evidence, so MCP005 still contributes at most two errors.
  A server may newly fail it on upgrade. (#5)

### Fixed

- Rule pages for MCP002, MCP012 and MCP015 showed TypeScript source under
  "Why this changed". The docs generator matched from the file's first `/**`
  rather than the comment directly above the rule, so any helper with its own
  doc comment was swept in.

## [0.2.0] — 2026-09-27

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

- The weekly compliance index never recorded a scan. Its commit job pushed to
  `main`, whose ruleset requires a pull request and CI, so every push was
  rejected (`GH013`) and the 2026-09-07, -14 and -21 scans were lost. Results
  now go to a dedicated `index-data` branch; `main` keeps only the cohort
  (`index/targets.json`), and a test pins the push target.
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

[Unreleased]: https://github.com/Khanthtutzin/mcp-stateless/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Khanthtutzin/mcp-stateless/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Khanthtutzin/mcp-stateless/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Khanthtutzin/mcp-stateless/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.5
[0.1.4]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.4
[0.1.3]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.3
[0.1.0]: https://github.com/Khanthtutzin/mcp-stateless/releases/tag/v0.1.0
