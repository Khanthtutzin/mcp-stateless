/**
 * The single place that knows how a file in this repository maps to a page on
 * this site.
 *
 * Both halves of the content pipeline read it: the loader, to decide what to
 * publish and under which slug, and the link-rewriting remark plugin, to turn
 * a relative `../README.md` written for a GitHub reader into a working site
 * URL. Keeping one map means the two can never disagree — a page that exists
 * is always linkable, and a link that resolves always points at a real page.
 */

/** Served from https://<user>.github.io/mcp-stateless/, so every path is prefixed. */
export const SITE_BASE = '/mcp-stateless/';

export const REPO_URL = 'https://github.com/Khanthtutzin/mcp-stateless';
export const REPO_BLOB = `${REPO_URL}/blob/main/`;
export const NPM_URL = 'https://www.npmjs.com/package/mcp-stateless';

/**
 * The npm release the GitHub Action pins itself to. A moving `v1` tag only
 * exists from 1.0.0 onward, so until then every example on the site must name
 * an exact release — and must name the same one, which is why it lives here
 * rather than being retyped into each code sample.
 */
export const ACTION_REF = 'v0.1.5';

/** Repository-relative files published outside `docs/`, and their slugs. */
const ROOT_PAGES: Record<string, string> = {
  'README.md': '',
  'CONTRIBUTING.md': 'contributing',
  'SECURITY.md': 'security',
  'CHANGELOG.md': 'changelog',
  'CODE_OF_CONDUCT.md': 'code-of-conduct',
};

/** Files under `docs/` published at a slug that is not simply their name. */
const DOC_PAGES: Record<string, string> = {
  'docs/overview.md': 'overview',
  'docs/rules/README.md': 'rules',
  'docs/ARCHITECTURE.md': 'architecture',
  'docs/migration-walkthrough.md': 'migration-walkthrough',
  'docs/usage.md': 'usage',
  'docs/faq.md': 'faq',
  'docs/ci.md': 'ci',
};

/** `docs/rules/MCP001.md` → `rules/mcp001`. */
const RULE_FILE = /^docs\/rules\/(MCP\d{3})\.md$/;

/**
 * The slug a repository-relative path is published under, or `null` if that
 * file is not published. `null` is not a failure — LICENSE and the working
 * documents under `docs/superpowers/` are deliberately absent, and the caller
 * falls back to a GitHub URL.
 */
export function slugFor(repoPath: string): string | null {
  const normalised = repoPath.replace(/\\/g, '/');
  if (normalised in ROOT_PAGES) return ROOT_PAGES[normalised]!;
  if (normalised in DOC_PAGES) return DOC_PAGES[normalised]!;
  const rule = RULE_FILE.exec(normalised);
  if (rule) return `rules/${rule[1]!.toLowerCase()}`;
  return null;
}

/** An absolute site path for a slug, with the base prefix and a trailing slash. */
export function urlForSlug(slug: string): string {
  return slug === '' ? SITE_BASE : `${SITE_BASE}${slug}/`;
}

/** Every non-rule file this site publishes, in sidebar order. */
export const PUBLISHED_FILES: readonly string[] = [
  'docs/overview.md',
  'docs/usage.md',
  'docs/ci.md',
  'docs/faq.md',
  'docs/rules/README.md',
  'docs/migration-walkthrough.md',
  'docs/ARCHITECTURE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
];
