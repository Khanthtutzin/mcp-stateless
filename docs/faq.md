# Questions

## Do I need to install anything?

No. `npx mcp-stateless --stdio "node dist/server.js"` fetches and runs the
published package. It has zero runtime dependencies, so there is nothing to
resolve beyond the package itself.

## Is it safe to point at a running server?

It never calls a tool. Tools have side effects, and a conformance check that
invoked them would be unsafe to point at anything real. It exercises the
protocol envelope — discovery, list results, error codes, headers — not your
logic.

Only probe an endpoint you operate or have permission to test. Over HTTP it
holds a real conversation with whatever answers.

## A rule fired on a server I believe is correct

That is a bug, and it is the most useful thing you can report. Open an issue
with the rule id and, if you can, the output of `--verbose`, which prints the
JSON-RPC exchange behind the finding.

This is not a hypothetical invitation. Testing against the migrated TypeScript
SDK found five defects in this tool, every one of which produced a false result
against a correctly migrated server, and none of which the fixture suite could
have surfaced — the fixtures encoded the same assumptions as the rules. All
five are fixed and covered by regression tests. The
[migration walkthrough](migration-walkthrough.md) documents what they were.

## Why did it report findings that are not my fault?

Because most of them are not. A server built on a stock SDK gets its `ping`
handler, its error codes and its result envelopes from that SDK. Telling you to
delete a `ping` handler you never wrote would send you hunting through code you
do not maintain.

So every rule declares who fixes it, and the summary splits on that line. Seven
findings can mean zero work for you and one dependency bump. Three of the
eighteen rules — MCP013, MCP015 and MCP017 — land on your own code; the rest
are SDK plumbing.

## It says UNREACHABLE and reported nothing

The server never answered, so nothing was measured. Eighteen confident verdicts
about a server that failed to start would be worse than nothing, so the check
reports no findings at all and exits `2` rather than `1` — nothing failed,
because nothing ran.

Check that the `--stdio` command starts the server on its own, that `--cwd` is
right if it depends on a working directory, and that `--timeout` is long enough
for a slow start.

## What is not covered?

Four changes need an authentication flow or an interactive scenario to probe
honestly, and checking them unreliably would be worse than not checking them.
They are tracked as issues rather than implemented as unreliable rules:

- Multi Round-Trip Request conformance (SEP-2322)
- Tasks extension migration (SEP-2663)
- RFC 9207 `iss` validation (SEP-2468)
- Client ID Metadata Documents

See [the rule catalogue](rules/README.md) for the eighteen that are covered.

## How is this different from the official codemod?

[`@modelcontextprotocol/codemod`](https://www.npmjs.com/package/@modelcontextprotocol/codemod)
rewrites the v1→v2 SDK API surface — imports, symbol renames, handler
signatures — and explicitly stops there. In its own words, adopting the
2026-07-28 protocol revision "is architectural and not codemod-automatable".

That leaves the question static rewriting cannot answer: does the server I am
now running actually conform? The codemod changes your code; this asks your
server. They are complementary, and running this after the codemod is the
point.

## Why does it not just read my package.json?

Because a version string is a claim, not a behaviour. A server can depend on an
SDK that targets 2026-07-28 and still fail conformance — through a hand-written
handler, a wrapper, a proxy, or a transport that was configured before the
upgrade. Asking the running server cannot be misled by any of that.

## Can I run only one rule?

```bash
npx mcp-stateless --stdio "node dist/server.js" --only MCP001
```

`--skip` is the inverse. Both take comma-separated ids, and an id that does not
exist is a usage error rather than a silent no-op — a typo in a CI config
should not quietly reduce your coverage. `--list-rules` prints the catalogue.

## Which exit code means what?

`0` ready, `1` findings at or above `--fail-on`, `2` usage error, unreachable
server, or an `--emit` file that could not be written. [Usage](usage.md) has
the detail.

## Is this an official MCP project?

No. It is an independent open-source project, not affiliated with, endorsed by,
or an official part of the Model Context Protocol project or Anthropic. "Model
Context Protocol" and MCP are used only to describe what this tool checks
against.
