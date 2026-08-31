# In CI

Running the check on every pull request turns a twelve-month migration deadline
into something you cannot drift past without noticing.

## The action

```yaml
- uses: Khanthtutzin/mcp-stateless@v0.1.5
  with:
    stdio: node dist/server.js
    fail-on: error
```

The action ref pins the checker as well as the action. It runs the npm version
it was released with, not whatever npm currently calls latest, so a release
published tomorrow cannot change today's result. Override with the `version`
input if you need a different one.

A moving `v1` tag will exist from 1.0.0 onward. Until then, pin the exact
release as above.

### A complete workflow

```yaml
name: MCP conformance

on: [push, pull_request]

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: '22'
      - run: npm ci && npm run build

      - uses: Khanthtutzin/mcp-stateless@v0.1.5
        with:
          stdio: node dist/server.js
          fail-on: error
```

The server has to be built before it can be probed — the check spawns your
server, it does not compile it.

## Inputs

| Input | Default | Description |
| ----- | ------- | ----------- |
| `stdio` | — | Command that starts the server on stdio. Mutually exclusive with `http`. |
| `http` | — | Streamable HTTP endpoint. Mutually exclusive with `stdio`. |
| `header` | — | Extra HTTP header as `Name: value`. One per line for several. |
| `format` | `text` | `text`, `json`, `sarif` or `markdown`. |
| `output` | — | Write the report to this file instead of stdout. |
| `fail-on` | `error` | Fail the step on `error`, `warning`, or `never`. |
| `only` | — | Comma-separated rule ids to run exclusively. |
| `skip` | — | Comma-separated rule ids to skip. |
| `timeout` | — | Per-request timeout in milliseconds. |
| `verbose` | `false` | Include the JSON-RPC traffic behind each finding. |
| `summary` | `true` | Append a markdown report to the GitHub step summary. |
| `version` | the release's own | npm version of `mcp-stateless` to run. |

## Outputs

| Output | Description |
| ------ | ----------- |
| `ready` | `"true"` when no breaking issues were found |
| `errors` | Number of breaking findings |
| `warnings` | Number of advisory findings |

The three outputs and the printed report all come from **one probe**. That is
worth stating because it was once not true: the action used to invoke the
checker three times — once for the JSON behind its outputs, once for your
chosen format, once for the step summary — and three probes mean three verdicts.
Against a flaky server the `errors` output could contradict the report printed
directly above it. It now probes once and renders many times.

Use the outputs to react without re-running anything:

```yaml
- uses: Khanthtutzin/mcp-stateless@v0.1.5
  id: check
  with:
    stdio: node dist/server.js
    fail-on: never

- name: Comment when not ready
  if: steps.check.outputs.ready != 'true'
  run: echo "::warning::${{ steps.check.outputs.errors }} breaking findings"
```

Note the `fail-on: never`: without it the step fails before the next one runs.

## Findings in the Security tab

SARIF output puts each finding on the exact line of your workflow's run in the
GitHub code-scanning UI, and inline on pull requests.

```yaml
- uses: Khanthtutzin/mcp-stateless@v0.1.5
  with:
    stdio: node dist/server.js
    format: sarif
    output: mcp-stateless.sarif
    fail-on: never

- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: mcp-stateless.sarif
```

`fail-on: never` is deliberate here too. If the check fails the job, the upload
step never runs and the findings never reach the Security tab — you lose the
report precisely when it has something to say.

## Outside GitHub Actions

The action is a thin wrapper. Any CI system can run the same command, and the
exit codes are the whole contract:

```bash
npx mcp-stateless --stdio "node dist/server.js" --emit sarif:report.sarif
```

`0` ready, `1` findings, `2` usage error or unreachable server. See
[Usage](usage.md) for the full set of flags.

## Choosing a threshold

Start at `fail-on: error`. Breaking findings are the ones that stop a
2026-07-28 client from working with your server at all, and every one of them
names whether an SDK upgrade or your own code resolves it.

Move to `fail-on: warning` once you are clean, so the advisories cannot
accumulate quietly. Use `never` only where something downstream — a SARIF
upload, a comment, a report artefact — has to run regardless.
