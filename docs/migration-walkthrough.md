# Migrating a real server to 2026-07-28

A complete before-and-after on a working MCP server: what `mcp-stateless`
reports, what each finding means, what the fix actually is, and — the part most
migration guides skip — what the tool got wrong and what it cannot tell you.

Everything below is real output from a real run. No illustrative examples.

**Contents**

- [The subject](#the-subject)
- [Before: 7 breaking issues](#before-7-breaking-issues)
- [Reading the report](#reading-the-report)
- [The findings, one at a time](#the-findings-one-at-a-time)
- [The migration](#the-migration)
- [After: READY](#after-ready)
- [What the tool got wrong](#what-the-tool-got-wrong)
- [What it still cannot tell you](#what-it-still-cannot-tell-you)
- [Doing this on your own server](#doing-this-on-your-own-server)

---

## The subject

A deliberately ordinary server — two tools, no resources, no prompts — on the
current released SDK, `@modelcontextprotocol/sdk@1.30.0`. It is the shape most
MCP servers in the wild actually have.

```js
// server.js — before
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'notes', version: '1.0.0' });

server.tool('add-note', 'Store a note.', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `Stored: ${text}` }],
}));

server.tool('list-notes', 'List stored notes.', {}, async () => ({
  content: [{ type: 'text', text: 'No notes yet.' }],
}));

await server.connect(new StdioServerTransport());
```

Nothing here is wrong. It was correct when it was written, and it is still
correct against the 2025 revisions. It simply predates 2026-07-28.

## Before: 7 breaking issues

```bash
npx mcp-stateless --stdio "node server.js"
```

```
mcp-stateless — checking against MCP 2026-07-28
target: node server.js (stdio)

Breaking (7)

  × MCP001  server/discover is not implemented (SDK)
      found     server/discover returned JSON-RPC error -32601: Method not found.
      expected  Servers MUST implement server/discover, advertising supported protocol
                versions, capabilities and identity.
      fix       Add a server/discover handler returning { supportedVersions, capabilities },
                with identity in _meta. Current SDKs implement this for you once upgraded.
      spec      https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle

  × MCP002  Server still accepts the removed initialize method (SDK)
  × MCP004  Results are missing the required resultType field (SDK)
  × MCP005  List results are missing the required ttlMs and cacheScope fields (SDK)
  × MCP005  List results are missing a valid cacheScope (SDK)
  × MCP006  The removed ping method is still implemented (SDK)
  × MCP009  subscriptions/listen is missing despite advertised listChanged (SDK)

Deprecations and advisories (1)

  ! MCP018  Results do not identify the server via _meta serverInfo (SDK)

NOT READY — 7 breaking issues across 14 checks.
  7 of those are protocol plumbing owned by your MCP SDK — upgrading to a release that
  targets 2026-07-28 resolves them with no change to your code.
  None require a change to your own code.
Finished in 281ms.
```

Exit code `1`.

_Findings are abbreviated above after the first. Every one carries the same four
lines — found, expected, fix, spec — and `--verbose` adds the JSON-RPC exchange
behind it._

## Reading the report

The last three lines matter more than the list.

Seven findings looks like a week of work. It is not. **All seven are protocol
plumbing the SDK owns.** Nobody wrote a `ping` handler in that file — the SDK
registered one. Nobody chose to omit `resultType` — the SDK's response
serialiser predates the field.

That is why every rule declares who fixes it, and why the summary splits on that
line. Here the honest answer is that there is nothing for the author to do yet:
this server is waiting on an SDK release, not on a developer. Knowing that is
worth more than the list above it.

## The findings, one at a time

### MCP001 — `server/discover` is not implemented

2026-07-28 removed the `initialize` handshake, so there is no longer a moment
where the server introduces itself. `server/discover` replaces it, and is now
mandatory. A client that speaks only the new revision has no other way to learn
which protocol versions you support.

**Who fixes it:** the SDK.

### MCP002 — `initialize` is still accepted

The mirror of MCP001. The handshake is gone from the schema entirely — the
string `initialize` does not appear in it.

Note the wording: _still accepts_, not _still requires_. This server answers
`tools/list` with no handshake, so a new-era client can already talk to it. A
server that **requires** the handshake is a harder break, and the tool reports
that separately and more severely.

**Who fixes it:** the SDK.

> **If you serve both eras deliberately, this is not a fault.** A server that
> implements `server/discover` _and_ still answers `initialize` is dual-era, the
> migration path the SDK documents as the recommended first step.
> `mcp-stateless` recognises that and reports it as an advisory, not an error.

### MCP004 — results missing `resultType`

Every result now carries `resultType: "complete"`, or `"input_required"` for the
interim step of a Multi Round-Trip Request. Clients are told to treat a missing
field as `"complete"`, so omitting it is survivable today — but it permanently
blocks the server from ever using MRTR, because there is no way to signal the
interim state.

**Who fixes it:** the SDK.

### MCP005 — list results missing `ttlMs` and `cacheScope`

Two findings, one per field. Now that list endpoints no longer vary per
connection, they are cacheable, and `CacheableResult` requires both a freshness
hint and a scope. This is where much of the practical benefit of going stateless
comes from: clients stop re-polling, and shared intermediaries can cache.

`cacheScope` is the one field here with a genuine judgement in it — `"private"`
if the response depends on who is asking, `"public"` if any caller would get the
same answer. The SDK supplies conservative defaults (`ttlMs: 0`,
`cacheScope: "private"`), which are safe but forgo the benefit. Worth revisiting
per endpoint after you upgrade.

**Who fixes it:** the SDK, with a judgement call left to you.

### MCP006 — `ping` is still implemented

`ping` existed to keep a session alive. With no session, it went. Liveness is a
transport concern now: process liveness for stdio, an HTTP health endpoint
otherwise.

**Who fixes it:** the SDK.

### MCP009 — `subscriptions/listen` missing despite advertised `listChanged`

The most interesting finding here, and the one that turned out to be wrong.

The server advertises `tools.listChanged: true` — a promise to tell clients when
the tool list changes. Under 2026-07-28 the only way to deliver on that promise
is `subscriptions/listen`, which this server does not implement. The old
per-resource `subscribe` RPC and the HTTP GET stream are both gone.

So the capability is a promise the server cannot keep. Two resolutions exist in
principle: implement the stream, or stop advertising the capability.

In practice neither is your job. The v1 SDK sets `listChanged: true` by
default — the author never chose it — and the v2 SDK implements
`subscriptions/listen`, so the upgrade keeps the promise on your behalf. This
fires against essentially every unmigrated TypeScript server, and says more
about an SDK default than about anyone's code.

**Who fixes it:** the SDK. It was originally attributed to the author, which was
wrong — see [What the tool got wrong](#what-the-tool-got-wrong).

### MCP018 — results do not identify the server

An advisory, not a break. The handshake used to carry server identity exactly
once. Statelessly, servers identify themselves in each result's `_meta`, so a
client that reconnects — or an intermediary seeing one response in isolation —
can still attribute it.

**Who fixes it:** the SDK.

## The migration

Six of seven findings are SDK-owned, so the migration is an SDK upgrade plus a
small API change. The same two tools, on the v2 API:

```ts
// src/index.ts — after
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function createServer(): McpServer {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });

  server.registerTool(
    'add-note',
    {
      title: 'Add note',
      description: 'Store a note.',
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `Stored: ${text}` }] }),
  );

  server.registerTool(
    'list-notes',
    {
      title: 'List notes',
      description: 'List stored notes.',
      inputSchema: z.object({}),
    },
    async () => ({ content: [{ type: 'text', text: 'No notes yet.' }] }),
  );

  return server;
}

void serveStdio(createServer);
```

Four changes, none of them protocol-level:

| Change                                                                          | Why                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Imports move to `@modelcontextprotocol/server`                                  | v2 splits the monolith into packages                              |
| `.tool(name, desc, shape, fn)` becomes `.registerTool(name, {…}, fn)`           | Options object; raw schema shapes become `z.object(...)`          |
| The server is built by a **factory**, not constructed once                      | The serving entry owns the era decision and may build per request |
| `server.connect(new StdioServerTransport())` becomes `serveStdio(createServer)` | The transport entry decides which protocol era to serve           |

The official [`@modelcontextprotocol/codemod`](https://www.npmjs.com/package/@modelcontextprotocol/codemod)
automates the first two mechanically:

```bash
npx @modelcontextprotocol/codemod@latest v1-to-v2 .
```

It does not do the last two, and says so: adopting the 2026-07-28 protocol
revision "is architectural and not codemod-automatable". That boundary is
exactly why a runtime check is worth running afterwards — the codemod fixes your
source, and `mcp-stateless` tells you whether the result actually conforms.

## After: READY

```bash
npx mcp-stateless --stdio "node build/index.js"
```

```
mcp-stateless — checking against MCP 2026-07-28
target: node build/index.js (stdio)

READY — no breaking issues across 14 checks.
Finished in 711ms.
```

Exit code `0`. All seven findings cleared, including MCP009.

## What the tool got wrong

**MCP009 was misattributed, and this document is what caught it.** The rule
declared itself `application` — your code — reasoning that capabilities are the
server author's choice. Writing the migration disproved that: it cleared on the
SDK upgrade alone, because the v2 SDK implements `subscriptions/listen` while
still defaulting `tools.listChanged` to true. The promise is kept by the
framework.

The rule's _detection_ was right both times: it fired when the stream was
missing and stayed silent once it existed. The _attribution_ was wrong, and the
consequence was worse than a cosmetic error — the summary told maintainers one
item needed their attention when the honest answer was none, sending them into
code that was never the problem. Now corrected to `sdk`, which is why the
report above reads "None require a change to your own code."

**The probe used an invented parameter shape.** `subscriptions/listen` takes a
`notifications` field of type `SubscriptionFilter`; the rule was sending
`subscribe`. The v2 server rejected it with `-32602 Invalid params` rather than
`-32601 Method not found`, and since the rule only keys on method-not-found it
still reached the correct conclusion — by luck, not design. Now fixed to match
the schema.

Both were found by writing this document. Neither would have surfaced from the
fixture suite, because the fixtures encoded the same assumptions as the rules.

## What it still cannot tell you

Being clear about the edges is more useful than a longer feature list.

- **Whether your tools still work.** `mcp-stateless` never calls a tool — tools
  have side effects. It checks the protocol envelope, not your logic. A server
  can report READY and still be broken.
- **Multi Round-Trip Requests.** Provoking one means calling a tool that needs
  client input, which the tool will not do. Tracked as
  [#1](https://github.com/Khanthtutzin/mcp-stateless/issues/1).
- **Authorization.** RFC 9207 `iss` validation and Client ID Metadata Documents
  need a real auth flow. Tracked as
  [#3](https://github.com/Khanthtutzin/mcp-stateless/issues/3) and
  [#4](https://github.com/Khanthtutzin/mcp-stateless/issues/4).
- **The tasks extension.** Whether tasks moved out of the core protocol —
  [#2](https://github.com/Khanthtutzin/mcp-stateless/issues/2).
- **Anything a server only does under load, or on a code path the probe never
  touches.** Eighteen checks over one connection is a smoke test, not a proof.

There is also a timing caveat worth stating plainly: **as of 2026-08-18 there is
no released 2026-07-28 TypeScript SDK.** The latest published version is
`1.30.0`, from the day before the specification landed. The "after" state above
was produced by building `2.0.0-alpha.0` from source. The migration path is
real, but you cannot `npm install` your way to it yet.

## Doing this on your own server

```bash
npx mcp-stateless --stdio "<the command that starts your server>"
```

Then read the last three lines first. If everything is marked `(SDK)`, you are
waiting on an SDK release rather than on yourself — and the useful next step is
to watch for it, not to start editing.

In CI:

```yaml
- uses: Khanthtutzin/mcp-stateless@v0.1.5
  with:
    stdio: node dist/server.js
    fail-on: error
```

If a rule fires on a server you believe is correct, that is a bug in
`mcp-stateless` and the most valuable thing you can report. Two of the defects
fixed before the first release were found exactly that way. Please
[open an issue](https://github.com/Khanthtutzin/mcp-stateless/issues/new?template=false-positive.yml)
with the output of `--only <RULE> --verbose`.
