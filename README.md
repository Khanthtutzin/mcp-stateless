<div align="center">

# mcp-stateless

**Is your MCP server ready for the 2026-07-28 stateless specification?**

[![CI](https://github.com/Khanthtutzin/mcp-stateless/actions/workflows/ci.yml/badge.svg)](https://github.com/Khanthtutzin/mcp-stateless/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-stateless?color=cb3837&logo=npm)](https://www.npmjs.com/package/mcp-stateless)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![provenance](https://img.shields.io/badge/provenance-signed-6f42c1?logo=github)](https://www.npmjs.com/package/mcp-stateless#provenance)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Connects to a running MCP server, probes what it actually does, and tells you
exactly which of the 2026-07-28 breaking changes it fails — with the wire
traffic that proves it and the specific change that fixes it.

```bash
npx mcp-stateless --stdio "node dist/server.js"
```

</div>

---

## Why this exists

MCP revision [`2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
is the largest breaking change in the protocol's history. **MCP went stateless.**

| Removed                                | Added                                  |
| -------------------------------------- | -------------------------------------- |
| `initialize` handshake                 | `server/discover` (mandatory)          |
| `Mcp-Session-Id` and protocol sessions | Per-request `_meta` envelope           |
| `ping`, `logging/setLevel`             | `resultType` on every result           |
| `resources/subscribe` / `unsubscribe`  | `ttlMs` / `cacheScope` on list results |
| Server-initiated requests              | Multi Round-Trip Requests              |
| SSE stream resumability                | Renumbered protocol error codes        |

Every MCP server must migrate, on a twelve-month deprecation clock.

The official [`@modelcontextprotocol/codemod`](https://www.npmjs.com/package/@modelcontextprotocol/codemod)
rewrites the v1→v2 **SDK API surface** — imports, symbol renames, handler
signatures — and explicitly stops there. In its own words, adopting the
2026-07-28 protocol revision "is architectural and not codemod-automatable".

That leaves the question static rewriting cannot answer: **does the server I am
now running actually conform?** This asks the server itself.

## Quick start

No installation required.

```bash
# stdio
npx mcp-stateless --stdio "node dist/server.js"

# Streamable HTTP
npx mcp-stateless --http https://api.example.com/mcp

# with authentication
npx mcp-stateless --http https://api.example.com/mcp --header "Authorization: Bearer $TOKEN"
```

Exit `0` ready · `1` findings · `2` usage error, unreachable server, or an
`--emit` file that could not be written.

Every release is published from CI by npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), so each
version carries a signed SLSA provenance attestation tying it to the exact
workflow run and commit that built it. No publish token exists. Verify with:

```bash
npm audit signatures
```

## What a run looks like

```
mcp-stateless — checking against MCP 2026-07-28
target: node dist/server.js (stdio)

Breaking (7)

  × MCP001  server/discover is not implemented (SDK)
      found     server/discover returned JSON-RPC error -32601: Method not found.
      expected  Servers MUST implement server/discover, advertising supported protocol
                versions, capabilities and identity.
      fix       Add a server/discover handler returning { supportedVersions, capabilities },
                with identity in _meta. Current SDKs implement this for you once upgraded.
      spec      https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle

  × MCP004  Results are missing the required resultType field (SDK)
  × MCP006  The removed ping method is still implemented (SDK)
  × MCP009  subscriptions/listen is missing despite advertised listChanged (SDK)
  …

NOT READY — 7 breaking issues across 14 checks.
  7 of those are protocol plumbing owned by your MCP SDK — upgrading to a release
  that targets 2026-07-28 resolves them with no change to your code.
  None require a change to your own code.
```

`--verbose` adds the JSON-RPC exchange behind each finding.

> ### The SDK line is the point
>
> Most of what breaks is plumbing your SDK owns — you never wrote a `ping`
> handler, the SDK registered one. Telling you to delete it would send you
> hunting through code you do not maintain.
>
> So every rule declares **who fixes it**, and the summary splits on that line.
> Seven findings can mean zero work for you and one SDK upgrade. Knowing which
> is worth more than the list above it.

## Proven against real servers

Fixtures prove the rules against servers built to trip them. That is necessary
but not sufficient, so this is also run against real software.

**Unmigrated** — the official `@modelcontextprotocol/*` servers:

| Server                       | Breaking | Advisory |
| ---------------------------- | -------- | -------- |
| `server-everything`          | 10       | 2        |
| `server-memory`              | 9        | 1        |
| `server-filesystem`          | 7        | 1        |
| `server-sequential-thinking` | 7        | 1        |

**Migrated** — the TypeScript SDK at `2.0.0-alpha.0`, built from source:

| Example              | Transport | Verdict                    |
| -------------------- | --------- | -------------------------- |
| `server-quickstart`  | stdio     | READY, no findings         |
| `caching` (dual-era) | http      | READY, 1 dual-era advisory |

<details>
<summary><b>Testing against the migrated SDK found five defects in this tool</b></summary>

<br>

Every one produced a false result against a correctly migrated server, and none
would have surfaced from the fixture suite — the fixtures encoded the same
assumptions as the rules.

- The HTTP transport never sent the required `MCP-Protocol-Version` header, so
  a real v2 server rejected every probe and **seven rules fired spuriously**
- `server/discover` was checked for `protocolVersions`; the schema field is
  `supportedVersions`
- `serverInfo` was expected at the top level of `DiscoverResult`, where the
  schema does not define it
- A **dual-era** server — the SDK's own recommended migration path — was
  reported NOT READY
- `MCP009` blamed the server author for something only an SDK upgrade fixes

All fixed, all covered by regression tests. If a rule fires on a server you
believe is correct, that is a bug and the most useful thing you can report.

</details>

## A worked example

[**docs/migration-walkthrough.md**](docs/migration-walkthrough.md) takes a real
server from 7 breaking findings to READY: the full report, what every finding
means, the actual diff, and an honest account of what the tool got wrong and
what it still cannot tell you.

## What it checks

**18 rules**, each tied to a named changelog entry and SEP. Full detail in
[`docs/rules/`](docs/rules/README.md).

<details>
<summary><b>Breaking — 14 rules</b></summary>

<br>

| Rule                           | Check                                                  | Transports  | Fixed by    |
| ------------------------------ | ------------------------------------------------------ | ----------- | ----------- |
| [MCP001](docs/rules/MCP001.md) | `server/discover` not implemented                      | stdio, http | SDK upgrade |
| [MCP002](docs/rules/MCP002.md) | Still requires the `initialize` handshake              | stdio, http | SDK upgrade |
| [MCP003](docs/rules/MCP003.md) | Still uses the removed `Mcp-Session-Id` header         | http        | SDK upgrade |
| [MCP004](docs/rules/MCP004.md) | Results missing required `resultType`                  | stdio, http | SDK upgrade |
| [MCP005](docs/rules/MCP005.md) | List results missing `ttlMs` / `cacheScope`            | stdio, http | SDK upgrade |
| [MCP006](docs/rules/MCP006.md) | Removed `ping` still implemented                       | stdio, http | SDK upgrade |
| [MCP007](docs/rules/MCP007.md) | Removed `logging/setLevel` still implemented           | stdio, http | SDK upgrade |
| [MCP008](docs/rules/MCP008.md) | Removed `resources/subscribe` still implemented        | stdio, http | SDK upgrade |
| [MCP009](docs/rules/MCP009.md) | `subscriptions/listen` missing despite `listChanged`   | stdio, http | SDK upgrade |
| [MCP010](docs/rules/MCP010.md) | Removed HTTP GET stream endpoint still served          | http        | SDK upgrade |
| [MCP011](docs/rules/MCP011.md) | Resource-not-found still returns `-32002`              | stdio, http | SDK upgrade |
| [MCP012](docs/rules/MCP012.md) | Protocol error codes not renumbered                    | stdio, http | SDK upgrade |
| [MCP013](docs/rules/MCP013.md) | Rejects requests carrying the `_meta` envelope         | stdio, http | your code   |
| [MCP014](docs/rules/MCP014.md) | Rejects the required `Mcp-Method` / `Mcp-Name` headers | http        | SDK upgrade |

</details>

<details>
<summary><b>Deprecations and advisories — 4 rules</b></summary>

<br>

| Rule                           | Check                                          | Transports  | Fixed by    |
| ------------------------------ | ---------------------------------------------- | ----------- | ----------- |
| [MCP015](docs/rules/MCP015.md) | Declares deprecated Roots / Sampling / Logging | stdio, http | your code   |
| [MCP016](docs/rules/MCP016.md) | Deprecated HTTP+SSE transport                  | http        | SDK upgrade |
| [MCP017](docs/rules/MCP017.md) | `tools/list` ordering not deterministic        | stdio, http | your code   |
| [MCP018](docs/rules/MCP018.md) | Results do not identify the server via `_meta` | stdio, http | SDK upgrade |

</details>

<details>
<summary><b>Deliberately not covered yet</b></summary>

<br>

Some changes need an auth flow or an interactive scenario to probe honestly.
Checking them unreliably would be worse than not checking them, so they are
tracked as issues instead:

- [#1](https://github.com/Khanthtutzin/mcp-stateless/issues/1) Multi Round-Trip Request conformance — SEP-2322
- [#2](https://github.com/Khanthtutzin/mcp-stateless/issues/2) Tasks extension migration — SEP-2663
- [#3](https://github.com/Khanthtutzin/mcp-stateless/issues/3) RFC 9207 `iss` validation — SEP-2468
- [#4](https://github.com/Khanthtutzin/mcp-stateless/issues/4) Client ID Metadata Documents

It also never calls a tool — tools have side effects. It checks the protocol
envelope, not your logic.

</details>

## In CI

```yaml
- uses: Khanthtutzin/mcp-stateless@v0.1.5
  with:
    stdio: node dist/server.js
    fail-on: error
```

The action ref pins the checker: it runs the npm version it was released with,
not whatever is latest. Override with the `version` input if you need to.
A moving `v1` tag will exist from 1.0.0 onward — until then, pin the exact
release as above.

Or upload SARIF so findings appear in the Security tab and inline on pull
requests:

```yaml
- run: npx mcp-stateless --stdio "node dist/server.js" --format sarif --output results.sarif
  continue-on-error: true
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: results.sarif
```

<details>
<summary><b>All CLI options</b></summary>

<br>

```
--stdio <command>     Command that starts the server on stdio.
--http <url>          Streamable HTTP endpoint.
--header <k:v>        Extra HTTP header. Repeatable.
--cwd <dir>           Working directory for the --stdio command.

--format <fmt>        text (default), json, sarif, markdown.
--output <file>       Write the report to a file instead of stdout.
--emit <fmt>:<file>   Also write this format to this file. Repeatable.
--verbose             Include the JSON-RPC traffic behind each finding.
--no-color            Disable ANSI colour (NO_COLOR is honoured too).

--only <ids>          Comma-separated rule ids to run exclusively.
--skip <ids>          Comma-separated rule ids to skip.
--timeout <ms>        Per-request timeout. Default 10000.
--fail-on <level>     error (default), warning, or never.

--list-rules          Print the rule catalogue and exit.
--version, --help
```

A server that never answers is reported `UNREACHABLE` with **no findings at
all** — eighteen confident verdicts about a server that failed to start would be
worse than nothing.

</details>

<details>
<summary><b>Programmatic use</b></summary>

<br>

```ts
import { runChecks, StdioTransport } from 'mcp-stateless';

const transport = new StdioTransport('node dist/server.js');
const report = await runChecks(transport);
await transport.close();

for (const f of report.findings) {
  console.log(`${f.ruleId} ${f.severity} [${f.remediation}] ${f.title}`);
  console.log(`  fix: ${f.fix}`);
}
```

</details>

## How it works

`mcp-stateless` speaks **both** protocol revisions. It hand-rolls JSON-RPC
rather than using an MCP SDK, because an SDK abstracts away precisely what needs
observing — it performs the handshake for you and normalises errors.

The probe runs a fixed opening sequence whose ordering is load-bearing:

1. `server/discover` — mandatory now, harmless against a legacy server
2. `tools/list` **before any handshake** — on stdio a successful `initialize`
   would persist in the child process and mask a server that still requires it
3. Legacy `initialize` — expected to fail on a compliant server
4. `tools/list` again, only if step 2 failed and step 3 worked

That combination is the signature of a still-stateful server, and it is what
separates "requires the handshake" from "chokes on `_meta`" from "rejects the
routing headers" — three failures that look identical from outside.

**Zero runtime dependencies.** Argument parsing uses `node:util.parseArgs`, HTTP
uses the built-in `fetch`, and the terminal colours are twelve lines of ANSI.
Nothing is installed into your CI beyond this package.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full map.

## Contributing

Adding a rule is **one file plus one test** — rules never touch the transport
layer, only a shared `ProbeContext`. See [CONTRIBUTING.md](CONTRIBUTING.md) and
the [`good first issue`](https://github.com/Khanthtutzin/mcp-stateless/labels/good%20first%20issue)
label.

The suite runs every rule against real fixture MCP servers over real stdio and
real HTTP — one built to 2025-11-25, one to 2026-07-28, plus servers that fail
in specific ways. No mocks.

```bash
git clone https://github.com/Khanthtutzin/mcp-stateless.git
cd mcp-stateless && npm install && npm test
```

## Affiliation

An independent open-source project. Not affiliated with, endorsed by, or an
official part of the Model Context Protocol project or Anthropic. "Model Context
Protocol" and MCP are used only to describe what this tool checks against.

Findings reported about any third-party server describe that server's observable
protocol behaviour at a point in time, nothing more — and every one of them is
reproducible with a single command, printed alongside the finding.

## License

[MIT](LICENSE)
