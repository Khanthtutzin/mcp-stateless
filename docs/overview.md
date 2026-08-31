# What this project is

A complete explanation of `mcp-stateless`, assuming no prior knowledge of the
Model Context Protocol. Start here if someone has just pointed you at this
repository and you want the whole picture in one read.

Where to go afterwards: [Usage](usage.md) for every flag, [In CI](ci.md) for the
GitHub Action, [Questions](faq.md) for the short answers,
[Architecture](ARCHITECTURE.md) for how the code is put together, and the
[migration walkthrough](migration-walkthrough.md) for a real server taken from
seven failures to passing.

---

## 1. The background, from zero

**MCP — the Model Context Protocol — is how an LLM application talks to tools.**
When an assistant reads your files, queries your database, or searches your
issue tracker, it does not contain that capability itself. Something else does,
and MCP is the protocol between them.

The two sides are:

- A **client** — the LLM application. Claude Code, an IDE extension, a chat app.
- A **server** — a small program exposing tools, resources and prompts. A
  filesystem server, a Postgres server, a company's internal API wrapper.

They speak JSON-RPC 2.0 over one of two transports: **stdio**, where the client
launches the server as a child process and talks over its standard input and
output, or **Streamable HTTP**, where the server is a web endpoint. Thousands of
MCP servers exist, most of them small, most of them built on an official SDK,
and most of them maintained by one person in their spare time.

### What happened on 28 July 2026

MCP versions its specification by **publication date**, not semver — the version
_is_ `2026-07-28`. (There is no "MCP 3.0". See
[Architecture §2](ARCHITECTURE.md) for why a date is the right identifier for a
protocol revision.)

That revision made the protocol **stateless**, and it is the largest breaking
change in MCP's history:

| Removed                                           | Added or changed                   |
| ------------------------------------------------- | ---------------------------------- |
| the `initialize` connection handshake             | `server/discover`, now mandatory   |
| `Mcp-Session-Id` and protocol-level sessions      | a per-request `_meta` envelope     |
| `ping`, `logging/setLevel`, `resources/subscribe` | `resultType` on every result       |
| server-initiated requests                         | `ttlMs` / `cacheScope` on listings |
| SSE stream resumability                           | renumbered protocol error codes    |

Before this revision, a client connected, performed a handshake, negotiated a
version once, and the server remembered that connection. After it, **every
request stands alone** and carries its own version and capabilities. A server
that still expects a handshake before answering is not slightly outdated — it is
broken against every new client.

Every existing MCP server must migrate, on a twelve-month deprecation clock.

### The gap this project fills

The MCP project ships
[`@modelcontextprotocol/codemod`](https://www.npmjs.com/package/@modelcontextprotocol/codemod),
which rewrites the v1→v2 **SDK API surface** — imports, renamed symbols, handler
signatures — and explicitly stops there. In its own words, adopting the
2026-07-28 protocol revision "is architectural and not codemod-automatable".

So a maintainer can run the codemod, get a clean build, and still have no answer
to the only question that matters:

> **Does the server I am now running actually conform?**

Nothing shipped to answer that. This project answers it.

---

## 2. What the tool does

You point it at a **running** MCP server. It holds a real conversation with that
server, watches how the server answers, and reports exactly which of the
breaking changes it fails.

```bash
npx mcp-stateless --stdio "node dist/server.js"
npx mcp-stateless --http https://api.example.com/mcp
```

Every finding answers four questions:

1. **What did we see?** Quoting the actual values that came back.
2. **What does the spec require instead?** In the spec's own terms, with a deep
   link.
3. **What is the concrete change?** "Change the resource-not-found code from
   `-32002` to `-32602`", not "make your server compliant".
4. **Whose bug is it — yours or your SDK's?**

That fourth one is the feature maintainers actually respond to. A run against a
typical unmigrated server looks like this:

```
NOT READY — 7 breaking issues across 14 checks.
  7 of those are protocol plumbing owned by your MCP SDK — upgrading to a release
  that targets 2026-07-28 resolves them with no change to your code.
  None require a change to your own code.
```

Seven failures, zero work: bump one dependency. Without that split, the same run
reads as a week of unfamiliar protocol work, and the honest answer is that
**fifteen of the eighteen rules are things an SDK upgrade fixes**. Only three —
`MCP013`, `MCP015`, `MCP017` — land on code the author actually wrote.

### The three principles behind every design decision

**It probes behaviour, never source code.** No parsing your files, no reading
your lockfile, no trusting a version string. A version string is a claim; a
server can depend on a 2026-07-28 SDK and still fail through a hand-written
handler, a wrapper, or a proxy. Asking the running server cannot be misled by
any of that.

**It says who has to fix it.** Every rule declares
`remediation: 'sdk' | 'application'`, and every report splits on that line.

**It refuses to guess.** A server it cannot reach produces **zero** findings, not
eighteen — nothing was measured, so nothing failed. Where the spec permits two
behaviours, it reports neither. Being confidently wrong is the one failure mode
that would make the tool not worth running, so silence is preferred to a guess.

### What it deliberately never does

- **It never calls a tool.** Tools have side effects; a checker that invoked them
  would be unsafe to point at anything real. It exercises the protocol envelope,
  not your logic.
- **It never sends anything anywhere.** The only network traffic is to the server
  you named. There is no telemetry, and no service to receive it.
- **It does not check four things it cannot check honestly** — Multi Round-Trip
  Requests, the tasks extension, RFC 9207 `iss` validation, and Client ID
  Metadata Documents all need an auth flow or an interactive scenario. They are
  tracked as issues rather than shipped as unreliable rules.

---

## 3. What ships

One code path, four front doors:

| Artifact               | What it is                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| **CLI**                | `npx mcp-stateless …`. Four output formats: text, JSON, SARIF, Markdown.                                      |
| **Library**            | `import { runChecks, StdioTransport } from 'mcp-stateless'` — run the same checks inside your own test suite. |
| **GitHub Action**      | A composite action wrapping the CLI, with `ready` / `errors` / `warnings` outputs and a Markdown job summary. |
| **Documentation site** | The repository's own Markdown, rendered through Astro and Starlight.                                          |

Plus the parts that are not code: 18 rule pages generated from the rule sources,
a migration walkthrough written against a real server, and a changelog that
records what each release actually fixed.

---

## 4. How it works

Four layers, and dependencies only point one way:

```
CLI / library  →  runChecks  →  ProbeContext  →  Transport  →  the server
                      ↓
                  reporters (text · json · sarif · markdown)
```

### The probe sequence

Before any rule runs, the tool performs one fixed opening sequence and shares
the result. **The ordering is the cleverness of the whole tool:**

1. `server/discover` — mandatory now, harmless against a legacy server.
2. `tools/list` **before any handshake**. This must come first: on stdio a
   successful `initialize` would persist inside the child process and mask a
   server that still requires one.
3. the legacy `initialize` — expected to _fail_ on a compliant server.
4. `tools/list` again, only if step 2 failed and step 3 worked. That exact
   combination is the signature of a still-stateful server.
5. `tools/list` once more, to check whether listings come back in a stable order.

Why bother? Because three completely different faults look identical from
outside — "requires the handshake", "chokes on the `_meta` envelope", "rejects
the routing headers" all just return an error to a naive client. Only this
sequence tells them apart.

### Rules

Each of the 18 checks is one file that receives a `ProbeContext` and returns
findings. Rules never construct transports, never touch sockets, and never
depend on each other, which is what makes adding one a self-contained change:
one file, one registry line, one test. A rule that throws is recorded as
crashed, and the run continues — a crash is a bug in _this_ tool, and it must
not cost the user the other seventeen results.

Rule ids are **permanent**. A retired rule leaves a hole rather than letting a
`--skip MCP007` in someone's CI silently start suppressing a different check.

For the full internals — the `Exchange` record, the transport boundary, the
Windows `npx` spawn problem, the reporters — read
[Architecture](ARCHITECTURE.md).

---

## 5. The stack, and why

**Zero runtime dependencies.** Not a slogan — a constraint that shaped the code.
This runs inside other people's CI, and every dependency would be a
supply-chain surface they inherit by installing it.

| Concern          | Choice                                               | Instead of                                                                     |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| Language         | TypeScript 5.7, `strict`, `noUncheckedIndexedAccess` | — wire data is untrusted by definition                                         |
| Runtime          | Node ≥ 20, ESM                                       | needs built-in `fetch`, `parseArgs`, web streams                               |
| Argument parsing | `node:util.parseArgs`                                | commander / yargs                                                              |
| HTTP + SSE       | built-in `fetch`, hand-parsed `data:` frames         | undici, eventsource                                                            |
| Terminal colour  | ~12 lines of ANSI                                    | chalk / picocolors                                                             |
| Child processes  | `spawn`, never `shell: true`                         | — command strings are tokenized in-house so behaviour matches across platforms |
| Tests            | Vitest 3                                             | —                                                                              |
| Site             | Astro + Starlight, its own package                   | — fenced off so the published package stays dependency-free                    |

The one dependency-heavy corner is the documentation site, and it is deliberately
a separate package with its own lockfile so the published npm package never sees
it.

### Testing

**No mocks.** Every rule runs against real fixture MCP servers over real stdio
and real HTTP sockets. The fixtures are hand-written plain JavaScript rather than
SDK-based, because the suite needs servers that emit _wrong_ behaviour precisely
— stateful gating, a live `ping`, the old `-32002` code, non-deterministic
listings — and an up-to-date SDK would refuse to do any of it.

Every rule is tested in both directions, and the second matters more: **it must
catch the legacy behaviour, and it must stay silent against a compliant server.**
A tool that cries wolf gets uninstalled.

Current state: **106 tests across 9 suites**, plus a CI job that runs the built
CLI against its own fixtures and asserts the exit-code contract — ready exits
`0`, findings exit `1`, an unreachable server exits `2` without inventing
findings.

---

## 6. How work flows

### Developing

```bash
npm install          # devDependencies only; there are no runtime deps
npm test             # full suite against real fixture servers
npm run typecheck
npm run lint
npm run docs:rules   # regenerate docs/rules/ after editing a rule
npm run build
```

Adding a rule: write the file, register it, teach the fixture the bad behaviour,
test both directions, regenerate the rule docs, run the gates. The rule pages
under `docs/rules/` are **generated from the rule sources**, and CI fails if they
drift — so the prose explaining a check lives next to the code that performs it.

### Continuous integration

Three jobs on every push and pull request: the **test matrix** (Node 20/22/24 on
Ubuntu, plus Node 22 on Windows and macOS — because spawning processes and
tokenizing command strings differ per platform), **quality** (lint, formatting,
and rule-doc staleness), and **dogfood** (run the built CLI against the fixtures
and assert the contract, not just the code).

### Releasing

Tag `v*`, and the release workflow enforces four gates: the whole suite passes;
the tag matches `package.json`; the manifest survives npm's publish-time
rewriting (a dropped `./` prefix on `bin` once nearly shipped a CLI with no
executable); and publication happens through **npm trusted publishing** (OIDC).
No publish token exists to leak, and every version carries a signed provenance
attestation tying it to the workflow run and commit that built it.

---

## 7. Where the project stands

Released: `0.1.0`, then `0.1.3` through `0.1.5`.

The most informative release is **`0.1.3`**, which fixed five defects found by
pointing the tool at a genuinely migrated server rather than at fixtures. Every
one produced a **false result against a correct server**, and none could have
surfaced from the test suite, because the fixtures had encoded the same
assumptions as the rules:

- The HTTP transport never sent the required `MCP-Protocol-Version` header, so a
  real v2 server rejected every probe and **seven rules fired spuriously**.
- `server/discover` was checked for `protocolVersions`; the schema field is
  `supportedVersions`.
- A **dual-era** server — the SDK's own recommended migration path — was reported
  NOT READY.
- One rule blamed the server author for something only an SDK upgrade fixes.

That episode is why "a rule firing on a correct server is a bug, not a
preference" is written into the contributing guide, and why the results below are
stated with the versions they were measured against.

### Verified against real software

**Unmigrated** — the official `@modelcontextprotocol/*` servers:

| Server                       | Breaking | Advisory |
| ---------------------------- | -------- | -------- |
| `server-everything`          | 10       | 2        |
| `server-memory`              | 9        | 1        |
| `server-filesystem`          | 7        | 1        |
| `server-sequential-thinking` | 7        | 1        |

**Migrated** — the TypeScript SDK at `2.0.0-alpha.0`, built from source:
`server-quickstart` (stdio) is READY with no findings, and the dual-era `caching`
example (http) is READY with one advisory. Zero false positives, zero rule
crashes.

### In progress

- **An ecosystem compliance index** — a weekly, reproducible measurement of how
  much of the MCP ecosystem has migrated, published as a trend line. Designed and
  partly built; no backend, no database. The data is committed to this repository
  so the git history is the audit trail, and it stores verdicts only, never
  captured wire traffic.
- **The documentation site**, being rebuilt on Astro and Starlight so the site and
  the repository's Markdown can never disagree.

### Not done yet

A `v1` tag does not exist, so every documented Action example pins an exact
release. The four uncovered spec areas remain uncovered on purpose. And the
project has no external adoption data yet — it has been verified against real
software, but not yet used in anger by anyone else.

---

## 8. Affiliation

An independent open-source project. **Not** affiliated with, endorsed by, or an
official part of the Model Context Protocol project or Anthropic. "Model Context
Protocol" and MCP are used only to describe what this tool checks against.

Findings reported about any third-party server describe that server's observable
protocol behaviour at a point in time, nothing more — and every one of them is
reproducible with a single command, printed alongside the finding.

Licensed [MIT](../LICENSE).
