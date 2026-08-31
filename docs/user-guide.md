# User guide

How to take a server from "I have no idea whether this breaks" to a green run,
in the order you will actually do it.

This is the connective guide. It does not repeat the reference material:
[Usage](usage.md) lists every flag, [In CI](ci.md) covers the GitHub Action,
[Rules](rules/README.md) documents all eighteen checks, and
[Migrating a real server](migration-walkthrough.md) works one migration through
end to end. Start here if you want to know what to do next; go there for detail.

New to the protocol change itself? [What this project is](overview.md) explains
what happened on 28 July 2026 and why it needs a tool at all.

---

## 1. What you need

Node 20 or newer, and a server you can start. Nothing to install — `npx` fetches
the published package, which carries a signed provenance attestation tying it to
the workflow run that built it.

The check never modifies your server, your files, or your dependencies. It
starts a conversation, records what comes back, and exits.

## 2. Your first run

Point it at the command that starts your server:

```bash
npx mcp-stateless --stdio "node dist/server.js"
```

If the path has spaces, quote it. If the server needs a particular working
directory, add `--cwd`. For a hosted endpoint, use `--http` — but only against
an endpoint you operate or have permission to test, because the check holds a
real conversation with whatever answers.

A server that is already conformant says so and stops:

```
mcp-stateless — checking against MCP 2026-07-28
target: node dist/server.js (stdio)

READY — no breaking issues across 14 checks.
Finished in 80ms.
```

A server that is not gives you the list, then a summary:

```
NOT READY — 12 breaking issues across 14 checks.
  12 of those are protocol plumbing owned by your MCP SDK — upgrading to a
  release that targets 2026-07-28 resolves them with no change to your code.
  None require a change to your own code.
```

That last pair of lines is the part to read first. See §5.

## 3. The four things a run can tell you

A run does not simply pass or fail. It ends in one of four states, and the
difference between the last two matters more than it looks.

| Verdict       | Exit | What it means                                                | What to do                                             |
| ------------- | ---- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `READY`       | `0`  | Every check ran, none found a breaking issue                 | Wire it into CI (§9) so it stays that way              |
| `NOT READY`   | `1`  | Every check ran, some found breaking issues                  | Work through them (§5, §6)                             |
| `INCOMPLETE`  | `2`  | The server answered some probes and stopped answering others | Fix the crash, then re-run — this is **not** a verdict |
| `UNREACHABLE` | `2`  | Nothing answered at all                                      | Check the command, the path, the port                  |

`INCOMPLETE` exists because of a trap. Every rule treats a probe that got no
answer as telling it nothing, and reports no finding — which is right for the
rule and wrong for the run. Without a third state, a server that answered the
first probe correctly and then crashed came back as zero errors and `READY`: a
green verdict drawn from about one rule in eighteen. So a run that lost any
probe is never reported ready, and says how much it lost:

```
INCOMPLETE — 8 of 10 probes got no answer, so this is not a verdict.
  First failure: Server process exited (code=7, signal=none) before responding.
  Anything listed above is real, but the checks that went unanswered reported
  nothing either way. Re-run once the server stays up.
```

The usual cause is a server that crashes on the legacy `initialize` probe —
which is exactly the probe designed to provoke error paths, so the servers most
likely to hit this are the ones with the most to report.

`UNREACHABLE` deliberately reports nothing else:

```
UNREACHABLE — Server process exited (code=1, signal=none) before responding.

  No checks were run. Nothing here is a verdict on conformance.

  Transport diagnostics
    [exit] code=1 signal=none
```

Eighteen confident failures against a process that never started would be a
measurement of our own failure to connect. The transport diagnostics under it —
the server's own stderr, its exit code — are usually enough to see what went
wrong.

Both `2` cases are "no verdict", not "failed", and `--fail-on` does not change
them. That flag decides which _findings_ fail your build; it says nothing about
a probe that never finished.

## 4. Reading a finding

Every finding answers four questions in the same order, so you can act without
reading the specification first:

```
× MCP004  Results are missing the required resultType field (SDK)
    found     The tools/list result has no resultType field.
    expected  All results carry resultType: "complete" or "input_required".
    fix       Add resultType: "complete" to every ordinary result. Reserve
              "input_required" for interim Multi Round-Trip results.
    spec      https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
```

- **found** — what the probe actually observed. Not an inference.
- **expected** — what the target revision requires instead.
- **fix** — the concrete change.
- **spec** — a deep link, so you can check the tool rather than trust it.

`×` marks a breaking issue; `!` marks an advisory, which does not block
readiness. `--verbose` appends the JSON-RPC traffic behind each finding if you
want to see the exchange yourself.

## 5. Who has to fix it — the `(SDK)` marker

This is the most useful thing the tool tells you, and it came out of running the
checker against the official MCP servers: **almost nothing was the server
author's code.**

Every finding is marked as one of two kinds:

- **`(SDK)`** — protocol plumbing your MCP SDK owns. Upgrading to a release
  targeting `2026-07-28` resolves it with no change to your code. You never
  wrote the `ping` handler; the SDK registered it.
- unmarked — a choice you made: capabilities you declared, schemas you wrote,
  features you opted into.

Only three of the eighteen rules can ever land in the second group — `MCP013`,
`MCP015` and `MCP017`. Everything else is the SDK's.

**So the triage order is fixed:**

1. Upgrade your MCP SDK to a release that targets `2026-07-28`.
2. Re-run the check.
3. Work on whatever is left — that part is genuinely yours.

Doing it the other way round means reading eighteen findings, most of which
describe code you did not write and cannot change from where you are sitting.
The summary tells you the split before you scroll:

```
  12 of those are protocol plumbing owned by your MCP SDK — upgrading to a
  release that targets 2026-07-28 resolves them with no change to your code.
  None require a change to your own code.
```

## 6. Working through the findings

Once you are down to your own code, take one rule at a time. `--only` narrows
the run to the rule you are working on, which keeps the output short and the
loop fast:

```bash
npx mcp-stateless --stdio "node dist/server.js" --only MCP013
```

```
NOT READY — 1 breaking issue across 1 checks.
```

Re-run without `--only` when you think you are done, so nothing you changed
broke something else.

Each rule has its own page under [Rules](rules/README.md) with the reasoning and
the specification reference. For a full worked example — a real server, seven
breaking issues, every edit, and an honest account of what the tool got wrong
along the way — read [Migrating a real server](migration-walkthrough.md).

## 7. Accepting a finding you cannot fix yet

Sometimes a finding is real and you are not going to act on it this week. Skip
it explicitly rather than ignoring the whole check:

```bash
npx mcp-stateless --stdio "node dist/server.js" --skip MCP006,MCP007,MCP008
```

```
NOT READY — 8 breaking issues across 11 checks.
```

Two things make this safe to leave in a config file:

- **Rule ids are permanent.** A retired rule's number is never reissued, so a
  `--skip` you wrote a year ago cannot silently start suppressing something
  else.
- **The count of checks drops too** — from 14 to 11 above. The report tells you
  your coverage went down; it does not quietly pretend you are more conformant
  than you are.

`--fail-on` moves the line between exit `0` and `1` instead: `error` is the
default, `warning` also fails on advisories, and `never` always exits `0` for
findings, so you can collect a report without failing a build. It does not
affect exit `2` (§3).

`--list-rules` prints the whole catalogue with ids, severities, transports, and
which specification change each one comes from.

## 8. Reports for other tools

The default output is for a human at a terminal. Three other formats are for
machines:

| Format     | For                                                      |
| ---------- | -------------------------------------------------------- |
| `json`     | `schemaVersion: 1`, a stable public contract             |
| `sarif`    | SARIF 2.1.0, so findings appear in GitHub's Security tab |
| `markdown` | A PR comment or `$GITHUB_STEP_SUMMARY`                   |

`--format` chooses what goes to stdout, `--output` sends it to a file, and
`--emit <format>:<file>` writes additional formats from the same probe —
repeatable, so one conversation with the server produces every artefact you
need:

```bash
npx mcp-stateless --stdio "node dist/server.js" \
  --emit json:report.json \
  --emit sarif:report.sarif \
  --emit markdown:summary.md
```

One note for anything consuming the JSON: `ready: false` does not mean "has
findings". Check `unreachable` and `incomplete` first — either one means there
is no verdict to read.

## 9. Keeping it green

Once a server is ready, the job is to notice the day it stops being ready —
usually a dependency bump. The composite GitHub Action is one step:

```yaml
- uses: Khanthtutzin/mcp-stateless@v0.1.5
  with:
    stdio: node dist/server.js
    fail-on: error
```

[In CI](ci.md) has the full workflow, every input and output, how to get
findings into the Security tab, and how to run it outside GitHub Actions.

## 10. What it cannot tell you

Worth knowing before you rely on a green run:

- **It only sees what is on the wire.** It cannot read your source, so it cannot
  tell you that a handler ignores a field it accepted, or that your session
  state moved somewhere it can no longer observe.
- **It probes one server, once.** Behaviour that depends on load, on a second
  client, or on a warm cache is out of reach.
- **Eighteen rules are not the whole specification.** They are the breaking
  changes in `2026-07-28`. A ready server is a server that clears those.
- **stdio and Streamable HTTP only**, and an HTTP endpoint should be one you
  operate or have permission to test.

[Migrating a real server](migration-walkthrough.md) ends with a longer, blunter
version of this list, written after actually doing a migration.

---

## Where to go next

| You want                    | Read                                                |
| --------------------------- | --------------------------------------------------- |
| Every flag and exit code    | [Usage](usage.md)                                   |
| The GitHub Action           | [In CI](ci.md)                                      |
| What one rule means         | [Rules](rules/README.md)                            |
| A migration done end to end | [Migrating a real server](migration-walkthrough.md) |
| Short answers               | [Questions](faq.md)                                 |
| The background, from zero   | [What this project is](overview.md)                 |
| How the tool is built       | [Architecture](ARCHITECTURE.md)                     |
