# mcp-stateless

## Website & Product Presentation Improvement Roadmap

**Review of the `feat/website` branch**

**Goal:** make the project instantly understandable to a new developer while preserving the technical depth that already makes the repository credible.

## Bottom line

The project is already strong technically. The main opportunity is presentation: the website should explain the problem visually and simply before introducing protocol details. The strongest positioning is not merely “an MCP validator”; it is **“a black-box compliance check for the server you actually run.”**

**Recommended priority order:** Homepage clarity → visual explanation of how it works → quick-start confidence → diagnostic results → rules/documentation → ecosystem proof → polish and discoverability.

## Review basis

This review is grounded in the current public GitHub `feat/website` branch and the project overview supplied in this conversation. The branch presents the project as a checker that connects to running MCP servers, probes actual behavior, reports concrete failures, and distinguishes SDK-owned issues from application-owned issues. The repository includes the website, CLI, library, GitHub Action, tests, docs, and architecture materials.

---

# 1. What is already working well

- **The core value proposition is strong:** the project asks whether the running server actually conforms, rather than trusting a source-code rewrite or SDK version. The README states this clearly.
- **The quick-start commands are excellent:** zero-install usage through `npx` for stdio and Streamable HTTP, with authentication shown as a realistic example.
- **The diagnostic output is a major strength:** findings expose what was found, what was expected, and a concrete fix; the “SDK vs your code” distinction makes the output actionable.
- **The project has credible engineering proof:** real-server verification, regression tests, a multi-platform CI matrix, structured reporters, a GitHub Action, and a documented decision not to execute tools with side effects.
- **The scope is unusually honest:** several protocol areas are explicitly marked as not covered yet rather than being checked unreliably. That honesty should become part of the website’s trust message.

# 2. Biggest change I would make: simplify the first 10 seconds

### Current challenge

The repository is technically clear to someone who already knows MCP, but a first-time visitor has to process protocol terms very quickly. The website should **not** make the visitor understand MCP before understanding the problem the tool solves.

### Recommended homepage narrative

**Problem → simple explanation → visual flow → proof → quick start → deep technical docs**

## 2.1 Recommended hero section

### Headline

> **Is your MCP server actually ready for the stateless specification?**

### Supporting line

> Test the server you actually run. `mcp-stateless` probes real protocol behavior and tells you exactly what fails, what to change, and whether the fix belongs in your app or your SDK.

### Primary CTA

**Get started**

### Secondary CTA

**View the 18 rules**

### Visual to place directly below the hero

```text
Your MCP Server  →  mcp-stateless  →  18 checks  →  READY ✅ / NOT READY ❌
```

---

# 3. Add a visual “How it works” section

This should be the most important new visual on the site. It explains the black-box nature of the tool before the visitor sees protocol jargon.

1. **Connect** — Start the MCP server over stdio or point the checker at its Streamable HTTP endpoint.
2. **Probe** — Send a fixed, carefully ordered set of protocol requests without executing the server’s business tools.
3. **Observe** — Capture the server’s actual responses, transport behavior, headers, and result shapes.
4. **Evaluate** — Run the 18 rules against the shared probe context. Each rule is independent and has an explicit remediation owner.
5. **Explain** — Produce a report that says what happened, what the specification requires, and the concrete change needed.

---

# 4. Make “SDK vs your code” a first-class product feature

This is one of the project’s best differentiators and should be more prominent than it currently is. A developer does not only want a failure list; they want to know where responsibility lies.

- Show a small summary card near the top of every example report: **“7 findings — 5 SDK-owned, 2 application-owned.”**
- Use consistent visual labels in the website and docs: **SDK FIX**, **APP FIX**, **ADVISORY**, **NOT CHECKED**.
- Explain why this matters with one sentence: **“Do not hunt through application code for behavior your SDK is responsible for.”**
- Turn this into a core concept in the navigation and FAQ, not merely a note inside the sample output.

# 5. Rework the homepage information architecture

| #   | Section           | What the visitor sees                                    | Why it exists                                      |
| --- | ----------------- | -------------------------------------------------------- | -------------------------------------------------- |
| 1   | Hero              | What it is + one-line promise + Get started              | Make the value understandable without knowing MCP. |
| 2   | The problem       | “The SDK can compile and the server can still be wrong.” | Establish the gap the tool fills.                  |
| 3   | How it works      | Visual 5-step flow                                       | Explain the black-box approach.                    |
| 4   | See a real report | Short terminal output with 1–3 findings                  | Show the product, not just describe it.            |
| 5   | Why trust it      | Real servers + regression fixes + no tool execution      | Handle skepticism.                                 |
| 6   | What it checks    | 18-rule overview with filters                            | Let technical users inspect scope.                 |
| 7   | Run it            | stdio / HTTP / CI snippets                               | Convert interest into usage.                       |
| 8   | Deeper docs       | Migration walkthrough / architecture / rules             | Let experts go deep without burdening beginners.   |

---

# 6. Keep technical depth, but move it down the funnel

The detailed protocol tables, rule IDs, SEP references, transport behavior, JSON-RPC exchange, and architecture notes are valuable. **Do not remove them.** Change where they appear and how they are introduced.

- Begin with plain language: **“We send protocol requests to a running server and check the responses.”**
- Then introduce the exact sequence: `server/discover` → `tools/list` → `initialize` test → conditional follow-up checks.
- Then expose the deeper specification terms for readers who want them.

---

# 7. Improve the “What it checks” page

The current 18-rule catalogue is strong technically. Make it easier to scan by grouping rules into a few user-facing categories before showing the individual IDs.

| Category             | Plain-English meaning                                         | Current rules                  |
| -------------------- | ------------------------------------------------------------- | ------------------------------ |
| Protocol lifecycle   | Discovery, initialization, sessions, request envelopes        | MCP001–MCP004                  |
| Results & errors     | resultType, list metadata, error-code changes                 | MCP005, MCP011–MCP012          |
| Removed behavior     | ping, logging/setLevel, subscriptions, legacy HTTP GET stream | MCP006–MCP010                  |
| Transport & headers  | required HTTP headers and transport behavior                  | MCP003, MCP010, MCP014, MCP016 |
| Application behavior | `_meta` handling, deprecations, deterministic ordering        | MCP013, MCP015, MCP017         |
| Identity             | server identification in results                              | MCP018                         |

---

# 8. Put the trust story on the homepage

The project has unusually good evidence for an early-stage open-source tool. Surface that evidence more aggressively, but keep each claim compact.

- **Verified against real migrated and unmigrated MCP servers.**
- **106 tests across 9 suites.**
- **Zero runtime dependencies.**
- **Never calls your MCP tools.**
- **Unreachable means UNREACHABLE — not 18 invented failures.**
- **False positives found against real migrated software became regression tests.**

### Presentation rule

Do not put all of these into one giant badge wall. Pick **3–4 proof points** for the homepage and keep the rest in a **“Trust & design decisions”** section.

---

# 9. Improve the interactive experience where possible

The site can feel more like a product and less like rendered Markdown if the examples behave like a small interactive demo.

- Add a toggle between a clean summary report and `--verbose` JSON-RPC exchange.
- Allow visitors to click a finding to expand **found / expected / fix / spec**.
- Use a simple filter for SDK-owned vs application-owned findings.
- On the rules page, show transport applicability and remediation owner as compact badges.

---

# 10. Strengthen the call to action

The first user action should always be obvious. The current `npx` command is already ideal; the site should wrap it in a more deliberate conversion path.

1. **Primary action:** Copy command.
2. **Secondary action:** See a real example.
3. **Third action:** Add to GitHub Actions.

Recommended microcopy:

> **No install. No telemetry. No tool execution. Point it at a running MCP server.**

---

# 11. Improve open-source discoverability

- Add focused repository topics and a short GitHub repository description that repeats the core positioning in plain language.
- Make the website title/description searchable around terms such as **MCP compliance, MCP migration, stateless MCP, protocol conformance, and MCP CI checks**.
- Add a small **“Used in CI”** section with the GitHub Action snippet and SARIF workflow.
- Keep the branch-specific website work focused on presentation rather than adding unnecessary product features before the core message is polished.

---

# 12. Recommended visual style

The product is developer infrastructure, so the visual language should be **technical, calm, and evidence-oriented** rather than flashy.

- Dark or neutral technical base with one accent color for success/primary actions.
- Terminal/code blocks with generous spacing and high contrast.
- Large, simple diagrams instead of decorative AI artwork.
- Use status chips consistently: **READY**, **NOT READY**, **SDK**, **APP**, **ADVISORY**, **UNCHECKED**.
- Avoid overcrowding the hero with protocol terms. Reserve dense tables for deeper pages.

---

# 13. Suggested page structure for the full documentation site

### Home

Problem, promise, visual flow, sample report, trust, quick start, links to deep docs.

### Get Started

Installation-free first run, stdio, HTTP, authentication, exit codes.

### How It Works

Transport layer, probe sequence, shared `ProbeContext`, rule execution, reporters.

### Rules

18 checks with filters, severity, transport support, remediation owner, specification links.

### CI

GitHub Action, SARIF, fail-on behavior, version pinning, examples.

### Migration Walkthrough

A concrete before/after server journey from failures to READY.

### Architecture

Internal design for contributors and advanced users.

### Questions / FAQ

Plain-English answers to:

- “What is MCP?”
- “Does it call my tools?”
- “Can I run it offline?”
- “Why did it say SDK?”

---

# 14. Priority roadmap

| Priority | Change                                               | Why                                   | Rough effort |
| -------- | ---------------------------------------------------- | ------------------------------------- | ------------ |
| P0       | Rewrite the hero around the black-box promise        | Highest impact on comprehension       | 1 day        |
| P0       | Add the visual 5-step “How it works” flow            | Explains the product immediately      | 1–2 days     |
| P0       | Show a polished sample report with SDK/App ownership | Demonstrates the actual product value | 0.5–1 day    |
| P0       | Move protocol-heavy details below the core story     | Reduces cognitive load                | 0.5–1 day    |
| P1       | Restructure the rules page into categories + filters | Makes 18 rules easier to scan         | 1–2 days     |
| P1       | Create a dedicated trust/evidence section            | Converts credibility into confidence  | 0.5–1 day    |
| P1       | Add stronger CI and SARIF presentation               | Shows production usefulness           | 0.5–1 day    |
| P2       | Interactive report exploration                       | Makes the website feel like a product | 2–4 days     |
| P2       | Discoverability/SEO polish                           | Improves external discovery           | 0.5–1 day    |

---

# 15. What I would NOT change

- **Do not remove the detailed protocol explanations.** They are valuable once the visitor understands the problem.
- **Do not hide the fact that some checks are intentionally not covered yet.** That honesty strengthens trust.
- **Do not turn the product into a tool that executes MCP tools just to get deeper coverage.** The current safety boundary is a strong design decision.
- **Do not add a backend or telemetry service just to make the website look more sophisticated.** The project’s local, reproducible model is part of its appeal.
- **Do not overuse animations.** One or two purposeful protocol-flow animations would help; a marketing-heavy landing page would work against the developer-tool identity.

---

# 16. Final recommendation

I would keep the underlying product architecture almost exactly where it is and invest the next website effort in **clarity**. Your strongest story is already present in the repository: the checker talks to the running server, observes real behavior, and explains exactly what failed and who needs to fix it. The website should make that idea obvious before asking the visitor to understand terms such as `_meta`, `resultType`, sessions, or specific SEPs.

## One-line positioning to build around

> **Test the MCP server you actually run — not the SDK version you installed.**

---

**Reference reviewed:** https://github.com/Khanthtutzin/mcp-stateless/tree/feat/website
