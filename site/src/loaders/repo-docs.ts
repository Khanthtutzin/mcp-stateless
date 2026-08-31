import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Loader, LoaderContext } from 'astro/loaders';
import { PUBLISHED_FILES, slugFor } from '../docs-manifest';

/**
 * Publishes this repository's own Markdown as the site's `docs` collection.
 *
 * Starlight's `docsLoader()` reads `src/content/docs/`, which would mean either
 * moving the documentation into the site — making it worse to read on GitHub —
 * or keeping a second copy that drifts. It is a thin wrapper over Astro's
 * `glob()` loader, so replacing it costs nothing but the title handling below.
 *
 * The files were written for a GitHub reader and have no frontmatter, so the
 * page title is taken from the `# H1` and that heading is then removed:
 * Starlight renders its own title, and leaving it in would print it twice.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RULES_DIR = 'docs/rules';

export function repoDocsLoader(): Loader {
  return {
    name: 'repo-docs-loader',
    async load(context: LoaderContext) {
      const { store, parseData, renderMarkdown, generateDigest, watcher, logger } =
        context;

      const files = await collectFiles(logger);
      store.clear();

      for (const repoPath of files) {
        const slug = slugFor(repoPath);
        if (slug === null) {
          // collectFiles only yields mapped paths, so this is unreachable
          // unless the manifest and the sweep disagree — which is worth
          // failing loudly for rather than silently dropping a page.
          throw new Error(`repo-docs: ${repoPath} has no slug in the manifest`);
        }

        const absolute = path.join(REPO_ROOT, repoPath);
        const raw = await readFile(absolute, 'utf8');
        const { title, body } = splitTitle(raw, repoPath);

        const data = await parseData({
          id: slug,
          data: {
            title,
            description: firstParagraph(body),
            ...sidebarFor(slug),
          },
          filePath: repoPath,
        });

        const rendered = await renderMarkdown(body, {
          fileURL: pathToFileURL(absolute),
        });

        store.set({
          id: slug,
          data,
          body,
          // Relative to the repository root, so Starlight's edit links resolve
          // against GitHub without any further rewriting.
          filePath: repoPath,
          digest: generateDigest(raw),
          rendered,
        });

        watcher?.add(absolute);
      }

      logger.info(`Published ${files.length} pages from the repository`);
    },
  };
}

/**
 * The explicit list, plus every rule page found on disk. Rules are swept rather
 * than listed because adding one is routine — a new rule should appear on the
 * site by existing, not by also being registered here.
 */
async function collectFiles(logger: LoaderContext['logger']): Promise<string[]> {
  const rules = (await readdir(path.join(REPO_ROOT, RULES_DIR)))
    .filter((name) => /^MCP\d{3}\.md$/.test(name))
    .sort()
    .map((name) => `${RULES_DIR}/${name}`);

  const files = [...PUBLISHED_FILES, ...rules];

  const present: string[] = [];
  for (const file of files) {
    try {
      await stat(path.join(REPO_ROOT, file));
      present.push(file);
    } catch {
      // A page named in the manifest but absent from disk is a real problem,
      // but not one worth failing a build over: the site should still deploy.
      logger.warn(`${file} is in the manifest but not on disk — skipping`);
    }
  }
  return present;
}

/**
 * Rule pages are listed in the sidebar by their id alone.
 *
 * Their titles are full sentences — "MCP005 — List results are missing the
 * required ttlMs and cacheScope fields" — and eighteen of those wrap to three
 * lines each, burying every other group below a wall of text. The id is also
 * how a reader arrives: they have a finding in a report that says MCP005, and
 * they are looking for that, not for a description they have already read.
 */
function sidebarFor(slug: string): { sidebar?: { label: string } } {
  const rule = /^rules\/(mcp\d{3})$/.exec(slug);
  return rule ? { sidebar: { label: rule[1]!.toUpperCase() } } : {};
}

/** Takes the first `# H1` as the title and removes it from the body. */
function splitTitle(raw: string, repoPath: string): { title: string; body: string } {
  const match = /^#[^\S\n]+(.+?)[^\S\n]*$/m.exec(raw);
  if (!match) {
    throw new Error(
      `repo-docs: ${repoPath} has no level-one heading to use as its title`,
    );
  }
  const body = raw.slice(0, match.index) + raw.slice(match.index + match[0].length);
  return { title: plain(match[1]!), body: body.replace(/^\s+/, '') };
}

/**
 * A description for the page's meta tags and search result, taken from the
 * first real paragraph. Badge rows, tables and blockquotes are skipped — the
 * README opens with six shields, which would make a poor summary.
 */
function firstParagraph(body: string): string | undefined {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text) continue;
    if (/^([#>|`<*-]|\d+\.|\[!)/.test(text)) continue;
    const summary = plain(text.replace(/\s+/g, ' '));
    if (summary.length < 40) continue;
    return summary.length > 160 ? `${summary.slice(0, 157).trimEnd()}…` : summary;
  }
  return undefined;
}

/** Inline Markdown reduced to the text a meta tag or sidebar can show. */
function plain(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .trim();
}
