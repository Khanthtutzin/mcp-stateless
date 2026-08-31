import { readdirSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import { satteri } from '@astrojs/markdown-satteri';
import { rewriteRepoLinks } from './src/plugins/rewrite-links';
import { NPM_URL, REPO_URL, SITE_BASE } from './src/docs-manifest';

/**
 * Rule pages are swept from disk rather than listed, so a new rule reaches the
 * sidebar by existing. Starlight resolves each entry's label from the page's
 * own title, which the loader takes from its `# H1`.
 */
const rulePages = readdirSync(new URL('../docs/rules', import.meta.url))
  .filter((name) => /^MCP\d{3}\.md$/.test(name))
  .sort()
  .map((name) => ({ slug: `rules/${name.slice(0, 6).toLowerCase()}` }));

export default defineConfig({
  site: 'https://khanthtutzin.github.io',
  base: SITE_BASE,

  // The docs live in `docs/` and are written for a GitHub reader, so their
  // relative `.md` links have to become site URLs. Sätteri is Astro's default
  // processor; Starlight appends its own plugins to the same list.
  markdown: {
    processor: satteri({ mdastPlugins: [rewriteRepoLinks] }),
  },

  integrations: [
    starlight({
      title: 'mcp-stateless',
      description:
        'Check whether an MCP server is ready for the 2026-07-28 stateless specification.',
      customCss: ['./src/styles/theme.css'],
      editLink: { baseUrl: `${REPO_URL}/edit/main/` },

      // No site search. This also stops the Pagefind index being built, so the
      // deployed output carries no search bundle at all rather than a hidden
      // one. The sidebar is the whole navigation surface: eighteen rule pages
      // listed by id, which is how a reader arrives — with a finding in hand.
      pagefind: false,
      social: [
        { icon: 'github', label: 'GitHub', href: REPO_URL },
        { icon: 'npm', label: 'npm', href: NPM_URL },
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [{ slug: 'usage' }, { slug: 'ci' }, { slug: 'faq' }],
        },
        {
          label: 'Rules',
          items: [{ slug: 'rules' }, ...rulePages],
        },
        {
          label: 'Guides',
          items: [{ slug: 'migration-walkthrough' }],
        },
        {
          label: 'Project',
          items: [
            { slug: 'architecture' },
            { slug: 'contributing' },
            { slug: 'security' },
            { slug: 'code-of-conduct' },
            { slug: 'changelog' },
          ],
        },
      ],
    }),
    react(),
  ],

});
