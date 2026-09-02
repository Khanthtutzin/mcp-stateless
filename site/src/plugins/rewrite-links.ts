import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_BLOB, slugFor, urlForSlug } from '../docs-manifest';

/**
 * Rewrites the relative Markdown links written for a GitHub reader into site
 * URLs.
 *
 * This is a Sätteri mdast plugin — it sees `link` nodes, not source text —
 * which is the whole reason it is a plugin rather than a few regular
 * expressions. `docs/ARCHITECTURE.md` contains shell samples with `../` paths
 * in them, and a textual pass would happily rewrite the inside of a fenced
 * code block.
 *
 * A target with no published page is not an error. It becomes a link to the
 * file on GitHub — LICENSE has no page and never will — and reports itself
 * once per build so a genuine typo is still visible.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Targets that are already fine: URLs, protocol-relative, anchors, absolute. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

/** The subset of Sätteri's API this plugin uses, typed locally so the site
 *  does not take a direct dependency on the processor's internals. */
interface LinkNode {
  url: string;
}
interface VisitorContext {
  readonly fileURL: URL | undefined;
  setProperty(node: LinkNode, key: 'url', value: string): void;
  report(options: { message: string; severity?: 'error' | 'warning' | 'info' }): void;
}

export function rewriteRepoLinks() {
  // One entry per unresolved target per document. Without the guard, a link
  // repeated across eighteen rule pages reports eighteen times and trains the
  // reader to ignore it.
  const reported = new Set<string>();

  const rewrite = (node: LinkNode, ctx: VisitorContext): void => {
    if (!node.url || EXTERNAL.test(node.url)) return;
    if (!ctx.fileURL) return;

    const [target, hash] = splitHash(node.url);
    // Only Markdown files become pages; a link to an asset is left alone.
    if (!/\.(md|markdown)$/i.test(target)) return;

    const from = fileURLToPath(ctx.fileURL);
    const repoPath = path
      .relative(REPO_ROOT, path.resolve(path.dirname(from), target))
      .replace(/\\/g, '/');

    const slug = slugFor(repoPath);
    if (slug === null) {
      // Not published. Point at the file on GitHub so the link still works.
      ctx.setProperty(node, 'url', `${REPO_BLOB}${repoPath}${hash}`);
      if (!reported.has(repoPath)) {
        reported.add(repoPath);
        ctx.report({
          message: `${repoPath} has no page on this site; linked to GitHub instead.`,
          severity: 'info',
        });
      }
      return;
    }

    ctx.setProperty(node, 'url', `${urlForSlug(slug)}${hash}`);
  };

  return {
    name: 'rewrite-repo-links',
    link: rewrite,
    definition: rewrite,
  };
}

function splitHash(url: string): [string, string] {
  const i = url.indexOf('#');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i)];
}
