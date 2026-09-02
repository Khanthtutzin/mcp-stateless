# Documentation site — design

**Date:** 2026-08-31
**Status:** approved, in implementation

## Goal

Turn the single-page landing at `site/` into a documentation site: a marketing
home page backed by every document this repository already contains, with a
sidebar, full-text search, and a light theme.

The model is [winutil.christitus.com](https://winutil.christitus.com/) — an
Astro/Starlight site whose home page is a landing and whose header carries the
docs. The shape is familiar to open-source visitors, which is the point: a
first-time reader should not have to learn this site.

## Why now

The project has eighteen rule pages, a migration walkthrough, and a sixteen-
section project guide, all reachable today only by clicking into GitHub blob
views. That is a worse reading experience than the material deserves, and it is
invisible to search engines that index rendered HTML rather than repository
files.

## Non-goals

- **No CMS, no backend, no analytics.** The site stays a static build.
- **No versioned docs.** One version, the current one. Revisited at 1.0.0 and
  kept: a per-major docs site is ongoing maintenance a single-command CLI does
  not earn, and the rule catalogue is generated from the rule sources, so the
  published docs cannot drift from the release they describe. Readers needing an
  older rule set have the tag.
- **No blog.**
- **No duplicated content.** If a page exists in the repository, the site
  renders that file rather than a copy of it. See "Content pipeline".

## Decisions taken

| Question                      | Decision                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| Scope                         | Full docs site, not a restyled landing                            |
| Framework                     | Astro + Starlight; React kept for existing interactive components |
| Where does content live?      | Stays in `docs/`; the site reads it in place                      |
| Theme                         | Dark and light, auto-detecting                                    |
| Home page                     | WinUtil's section rhythm, carrying this project's own thesis      |
| Hosting                       | GitHub Pages project path, base `/mcp-stateless/`                 |
| How does the landing coexist? | `<StarlightPage template="splash">`                               |

## Architecture

```
docs/**/*.md ─┐
CONTRIBUTING  ├─► src/loaders/repo-docs.ts ──► `docs` collection ──► Starlight
SECURITY      │      (H1 → title, strip)          (docsSchema)        routes
CHANGELOG    ─┘      renderMarkdown()                                 sidebar
                            │                                         search
                            ▼
                  plugins/rewrite-links.ts
                  (remark: relative .md → site route)
```

`site/` remains **deliberately not a workspace** of the root package, which must
keep zero runtime dependencies.

```
site/
  astro.config.mjs           # starlight + react + tailwind, base '/mcp-stateless/'
  src/
    content.config.ts        # one `docs` collection, fed by the loader
    loaders/repo-docs.ts     # reads the repository's own markdown
    plugins/rewrite-links.ts # remark plugin, runs inside renderMarkdown
    pages/index.astro        # the landing
    components/              # React islands: Hero, ReportOutput, CommandBar
                             # Astro: SectionHead, FeatureGrid, Steps, Cta
    styles/theme.css         # Starlight token overrides, dark and light
```

## Content pipeline

### What the loader reads

| Source                          | Route                     |
| ------------------------------- | ------------------------- |
| `docs/rules/README.md`          | `/rules/`                 |
| `docs/rules/MCP0NN.md`          | `/rules/mcp0nn/`          |
| `docs/migration-walkthrough.md` | `/migration-walkthrough/` |
| `docs/ARCHITECTURE.md`          | `/architecture/`          |
| `docs/usage.md` (new)           | `/usage/`                 |
| `docs/faq.md` (new)             | `/faq/`                   |
| `docs/ci.md` (new)              | `/ci/`                    |
| `CONTRIBUTING.md`               | `/contributing/`          |
| `SECURITY.md`                   | `/security/`              |
| `CHANGELOG.md`                  | `/changelog/`             |
| `CODE_OF_CONDUCT.md`            | `/code-of-conduct/`       |

`docs/superpowers/**` is excluded — specs and plans are working documents, not
published pages.

The three new pages are written into `docs/`, not into the site, so there is
exactly one content source and they are useful to a reader on GitHub too.

### What the loader does per file

1. Reads the file and takes the first `# H1` as the page `title`, then strips
   that heading — Starlight renders its own page title, and leaving it would
   print the heading twice.
2. Validates the result against `docsSchema()`.
3. Renders through `renderMarkdown()`, passing `fileURL` so the link plugin can
   resolve relative paths against the file's real location.
4. Registers the file with Astro's dev `watcher`, so editing a rule page in
   `docs/` hot-reloads the site.

### Link rewriting

A **remark plugin, not a regular expression** — it walks the AST, so relative
paths inside fenced code blocks and inline code are never touched.

| In the repository                 | On the site                               |
| --------------------------------- | ----------------------------------------- |
| `MCP001.md`                       | `/mcp-stateless/rules/mcp001/`            |
| `rules/README.md#not-yet-covered` | `/mcp-stateless/rules/#not-yet-covered`   |
| `../README.md`                    | `/mcp-stateless/`                         |
| `../../CONTRIBUTING.md`           | `/mcp-stateless/contributing/`            |
| anything unmapped                 | the GitHub blob URL, plus a build warning |

The fallback row is deliberate: an unmapped link degrades to a URL that works
rather than a 404, and still reports itself at build time.

### Risk, and the fallback

Starlight documents `docsLoader()`, which reads `src/content/docs/`.
Substituting a custom loader for that collection is permitted by Astro's
content-layer API but is not a documented Starlight configuration.

**Task 0 is therefore a spike, not construction**: prove one rule page renders
with the correct title, a sidebar entry, a table of contents, syntax
highlighting, and a Pagefind search hit — before anything else is built.

If Starlight rejects the custom loader, the fallback is contained: the same
transform becomes a prebuild step that writes converted copies into a gitignored
`site/src/content/docs/`, and `docsLoader()` is used unchanged. The transform
code is identical either way, which is why the clean version is attempted first.

## Information architecture

**Header** — logo, search, three link groups, theme toggle, GitHub and npm.

**Sidebar**

| Group           | Pages                                                    |
| --------------- | -------------------------------------------------------- |
| Getting started | Overview, Usage, In CI, FAQ                              |
| Rules           | Catalogue, then MCP001–MCP018                            |
| Guides          | Migration walkthrough                                    |
| Project         | Architecture, Contributing, Security, Changelog, Conduct |

Eighteen rule pages listed flat under one group is a long sidebar, and that is
correct: the catalogue is the product, and a reader arriving from a finding
wants to see the neighbouring rules.

## Home page

Winutil's rhythm, carrying this project's content:

1. **Hero** — the headline, the one `npx` command, and the existing two-tab
   report component. The tabs are the page's argument and stay above the fold.
2. **The problem** — what 2026-07-28 removed and added, as the existing
   two-column grid.
3. **Who fixes it** — the SDK-versus-your-code split. This is the section no
   competing page can write, and it keeps its emphasis.
4. **What it checks** — a sample of rules, linking into `/rules/`.
5. **Proven against real servers** — the statistics band.
6. **Getting started** — three steps: run it, read the finding, fix or upgrade.
7. **Closing** — call to action, plus the affiliation notice.

### Correction carried in from the docs

The current landing renders `uses: Khanthtutzin/mcp-stateless@v1`. The action
now pins the checker to the npm version it was released with, and the README
directs readers to pin the exact release until 1.0.0. Every occurrence on the
site becomes `@v0.1.5`, sourced from one constant so the next release changes it
in one place.

### Affiliation

The README's affiliation notice — independent project, not affiliated with or
endorsed by the Model Context Protocol project or Anthropic — appears in the
site footer on every page, not only on the home page.

## Visual system

The existing palette is kept and extended, not replaced: severity colour is the
CLI's own encoding and carries meaning rather than decoration.

- Dark stays the current deep indigo slate.
- Light is designed rather than derived. `break`, `advisory` and `ready` need
  light-background variants that hold their meaning and meet WCAG AA against
  the light surface; the dark values do not, so they are re-picked.
- Both themes are expressed as Starlight's CSS custom properties, so built-in
  components inherit them without per-component overrides.
- No web font is fetched. The site continues to make zero external requests,
  which keeps it fast and removes any flash of unstyled text.

## Build and CI

- `pages.yml` gains `docs/**` and the published root markdown files to its path
  filter — a docs edit must redeploy the site, which today it does not.
- The build keeps its own `lint`, `format:check` and `build` steps.
- Astro's `base` stays `/mcp-stateless/`; a custom domain later is a one-line
  change plus a `CNAME` file.
- The compliance-index spec expects an `@index` alias in `site/vite.config.ts`,
  which this rebuild deletes. The alias moves to `vite.resolve.alias` inside
  `astro.config.mjs`; that spec is amended to say so.

## Verification

| Check                | How                                                                  |
| -------------------- | -------------------------------------------------------------------- |
| Loader spike         | One rule page: title, sidebar, TOC, highlighting, search             |
| No broken links      | Build warns on unmapped `.md` targets; warnings treated as failures  |
| Every doc reachable  | Page count equals the loader's file count                            |
| Light theme contrast | Severity colours checked against the light surface for AA            |
| Search               | Pagefind returns a rule page for a rule id query                     |
| Deploy               | Pages build green, home and a rule page load under `/mcp-stateless/` |

## Out of scope

Versioned docs, i18n, a blog, per-server pages, and the compliance-index
section — the last has its own spec and lands after this.
