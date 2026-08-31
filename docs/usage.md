# Usage

Everything the command-line interface accepts, and what each exit code means.

Nothing needs installing. `npx` fetches the published package, which carries a
signed provenance attestation tying it to the workflow run that built it.

```bash
npx mcp-stateless --stdio "node dist/server.js"
```

## Choosing a target

Exactly one transport is required. They are mutually exclusive.

### stdio

The command is spawned, spoken to over its standard input and output, and
terminated when the run finishes.

```bash
npx mcp-stateless --stdio "node dist/server.js"
npx mcp-stateless --stdio "python -m my_server" --cwd ../server
```

`--cwd` sets the working directory for that command only. Without it, the
server inherits the directory you ran the check from.

### Streamable HTTP

```bash
npx mcp-stateless --http https://api.example.com/mcp
```

Add `--header` once per header. It takes `Name: value`, the same shape you
would write in a request.

```bash
npx mcp-stateless --http https://api.example.com/mcp \
  --header "Authorization: Bearer $TOKEN" \
  --header "X-Tenant: acme"
```

Only probe an endpoint you operate or have permission to test. The check holds
a real conversation with whatever answers.

## Options

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

### Selecting rules

`--only` and `--skip` take rule ids. An id that does not exist is a usage
error rather than a silent no-op — a typo in a CI config should not quietly
reduce your coverage.

```bash
# Just the one finding you are working on.
npx mcp-stateless --stdio "node dist/server.js" --only MCP001

# Everything except a rule you have consciously accepted.
npx mcp-stateless --stdio "node dist/server.js" --skip MCP017
```

`--list-rules` prints the catalogue and exits, which is the fastest way to
recover an id you half-remember.

### Rendering more than one format

`--format` chooses what goes to stdout. `--emit` writes additional renderings
of **the same run** to files, and is repeatable:

```bash
npx mcp-stateless --stdio "node dist/server.js" \
  --emit json:report.json \
  --emit sarif:report.sarif \
  --emit markdown:summary.md
```

This matters more than it looks. Running the checker three times to get three
formats means three separate probes, and against a server that is flaky or
stateful the counts in one can contradict the report printed beside it.
Everything `--emit` writes is rendered from the one report already in hand, so
the renderings agree by construction.

Files never receive ANSI escapes, whatever the terminal supports. A malformed
`--emit` is rejected before the server is spawned, so a typo costs you nothing.

## Exit codes

| Code | Meaning                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------- |
| `0`  | Ready — no findings at or above `--fail-on`                                                         |
| `1`  | Findings at or above `--fail-on`                                                                    |
| `2`  | Usage error, unreachable server, an incomplete probe, or an `--emit` file that could not be written |

`--fail-on` moves the line between `0` and `1`: `error` (the default) fails only
on breaking findings, `warning` also fails on advisories, and `never` exits `0`
whatever the findings, so you can collect a report without failing a build.

`--fail-on` does not cover `2`, and that is deliberate. It decides which
_findings_ should fail your build; it says nothing about a probe that never
finished. If the server dies or stops answering partway through, the report is
marked **INCOMPLETE** and the exit code is `2` even under `--fail-on never` —
because the checks that went unanswered reported nothing either way, and an
empty findings list from a server that stopped talking is not a pass.

Emitted files are written **after** the primary output, deliberately. A path
typo in a CI config should cost you the artefact, not the diagnostic output you
came for — so that case still prints the report, then exits `2` naming the path
it could not write.

## Unreachable servers

A server that never answers is reported `UNREACHABLE` with **no findings at
all**. Eighteen confident verdicts about a server that failed to start would be
worse than nothing, and being confidently wrong is the one failure mode that
would make the tool not worth running.

That case exits `2`, not `1`: nothing was measured, so nothing failed.

## Programmatic use

The rules and transports are exported, so the same checks can run inside your
own test suite.

```ts
import { runChecks, StdioTransport } from 'mcp-stateless';

const transport = new StdioTransport('node dist/server.js');
const report = await runChecks(transport);
await transport.close();

for (const finding of report.findings) {
  console.log(
    `${finding.ruleId} ${finding.severity} [${finding.remediation}] ${finding.title}`,
  );
}
```

`remediation` is the field that carries the answer to "whose bug is this" —
either the SDK owns it or your code does. See
[the rule catalogue](rules/README.md) for which rules fall where.

## What it never does

It does not call your tools. Tools have side effects, and a conformance check
that invoked them would be unsafe to point at anything real. It checks the
protocol envelope, not your logic.

It does not read your source, your lockfile, or your version strings. It asks
the running server questions and judges the answers, so it cannot be misled by
a dependency that claims a version it does not implement.
