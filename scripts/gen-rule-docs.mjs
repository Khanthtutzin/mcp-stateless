#!/usr/bin/env node
/**
 * Generate docs/rules/*.md from the rule sources.
 *
 * Rule files are the single source of truth: the metadata block supplies the
 * title, severity, transports and spec links, and the JSDoc comment above the
 * export supplies the rationale. Keeping the prose next to the code it
 * describes is the only way it stays true after a few contributions.
 *
 *   node scripts/gen-rule-docs.mjs           write the pages
 *   node scripts/gen-rule-docs.mjs --check   fail if they are out of date (CI)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rulesDir = join(root, 'src', 'rules');
const docsDir = join(root, 'docs', 'rules');
const TARGET_REVISION = '2026-07-28';

const check = process.argv.includes('--check');

function extract(source, file) {
  const pick = (re, name) => {
    const m = source.match(re);
    if (!m) throw new Error(`${file}: could not find ${name}`);
    return m[1];
  };

  const jsdoc = source.match(/\/\*\*([\s\S]*?)\*\/\s*export const MCP/);
  if (!jsdoc) throw new Error(`${file}: rule export has no JSDoc rationale`);

  return {
    rationale: jsdoc[1]
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim(),
    id: pick(/\bid:\s*'([^']+)'/, 'id'),
    title: pick(/\btitle:\s*'([^']+)'/, 'title'),
    severity: pick(/\bseverity:\s*'([^']+)'/, 'severity'),
    remediation: pick(/\bremediation:\s*'([^']+)'/, 'remediation'),
    specRef: `https://modelcontextprotocol.io/specification/${TARGET_REVISION}/${pick(
      /\bspecRef:\s*specUrl\('([^']+)'\)/,
      'specRef',
    )}`,
    changelogRef: pick(/\bchangelogRef:\s*'([^']+)'/, 'changelogRef'),
    appliesTo: pick(/\bappliesTo:\s*\[([^\]]+)\]/, 'appliesTo')
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .filter(Boolean),
  };
}

function page(rule) {
  return `# ${rule.id} — ${rule.title}

|  |  |
| --- | --- |
| **Severity** | \`${rule.severity}\` |
| **Fixed by** | ${
    rule.remediation === 'sdk'
      ? 'Upgrading your MCP SDK to a release targeting ' + TARGET_REVISION
      : 'A change in your own server code'
  } |
| **Transports** | ${rule.appliesTo.map((t) => `\`${t}\``).join(', ')} |
| **Specification** | [${TARGET_REVISION}](${rule.specRef}) |
| **Changelog entry** | ${rule.changelogRef} |

## Why this changed

${rule.rationale}

## Running just this check

\`\`\`bash
npx mcp-stateless --stdio "node dist/server.js" --only ${rule.id}
\`\`\`

## Suppressing it

If this check does not apply to your server, skip it:

\`\`\`bash
npx mcp-stateless --stdio "node dist/server.js" --skip ${rule.id}
\`\`\`

Rule ids are permanent and are never reissued, so a suppression cannot start
silently matching a different check later.

---

*Generated from [\`src/rules/${rule.id}.ts\`](../../src/rules/${rule.id}.ts) by
\`scripts/gen-rule-docs.mjs\`. Edit the rule source, not this page.*
`;
}

/**
 * User-facing groupings for the catalogue.
 *
 * Eighteen ids in one list is a reference, not an overview: a reader arriving
 * without a finding in hand cannot see what the tool covers. These group the
 * rules by the part of the protocol that changed, in plain language, before the
 * ids appear.
 *
 * The partition is asserted below — every rule belongs to exactly one area, and
 * adding a rule without placing it fails the build rather than quietly dropping
 * it out of the overview.
 */
const AREAS = [
  {
    name: 'Discovery',
    plain: 'How a client learns what a server can do, now that no handshake tells it.',
    ids: ['MCP001'],
  },
  {
    name: 'Statelessness',
    plain:
      'The handshake and per-connection sessions are gone; every request stands alone.',
    ids: ['MCP002', 'MCP003'],
  },
  {
    name: 'Removed methods',
    plain: 'Methods deleted in this revision, and the one that replaced subscriptions.',
    ids: ['MCP006', 'MCP007', 'MCP008', 'MCP009', 'MCP010'],
  },
  {
    name: 'Result shape',
    plain: 'Fields every result must now carry, including who produced it.',
    ids: ['MCP004', 'MCP005', 'MCP018'],
  },
  {
    name: 'Error codes',
    plain: 'Codes that moved into the reserved range, or changed meaning.',
    ids: ['MCP011', 'MCP012'],
  },
  {
    name: 'Request envelope',
    plain: 'The per-request `_meta` block and the headers that accompany it.',
    ids: ['MCP013', 'MCP014'],
  },
  {
    name: 'Deprecations',
    plain: 'Still works today, scheduled for removal or degrading behaviour.',
    ids: ['MCP015', 'MCP016', 'MCP017'],
  },
];

/** Fail the build if the areas above stop covering the rules exactly once each. */
function assertAreasPartition(rules) {
  const placed = AREAS.flatMap((a) => a.ids);
  const duplicated = placed.filter((id, i) => placed.indexOf(id) !== i);
  if (duplicated.length > 0) {
    throw new Error(`AREAS lists these rules more than once: ${duplicated.join(', ')}`);
  }
  const known = new Set(rules.map((r) => r.id));
  const unknown = placed.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`AREAS names rules that do not exist: ${unknown.join(', ')}`);
  }
  const missing = rules.map((r) => r.id).filter((id) => !placed.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `AREAS does not place these rules: ${missing.join(', ')}. ` +
        'Add each to an area in scripts/gen-rule-docs.mjs.',
    );
  }
}

function index(rules) {
  assertAreasPartition(rules);

  const owner = (r) => (r.remediation === 'sdk' ? 'SDK upgrade' : 'your code');
  const row = (r) =>
    `| [${r.id}](${r.id}.md) | \`${r.severity}\` | ${r.title} | ${owner(r)} | ${r.appliesTo.join(', ')} |`;
  const errors = rules.filter((r) => r.severity === 'error');
  const warnings = rules.filter((r) => r.severity === 'warning');
  const application = rules.filter((r) => r.remediation === 'application');

  const areaRow = (area) => {
    const ids = area.ids.map((id) => `[${id}](${id}.md)`).join(' · ');
    return `| **${area.name}** | ${area.plain} | ${ids} |`;
  };

  return `# Rule catalogue

Every check \`mcp-stateless\` performs against MCP ${TARGET_REVISION}, with the
changelog entry it enforces.

## By area

What the revision changed, and which checks cover each part of it.

| Area | What changed | Rules |
| --- | --- | --- |
${AREAS.map(areaRow).join('\n')}

## Who has to fix it

Every rule declares an owner, and it is the most useful column in the table
below. ${rules.length - application.length} of the ${rules.length} rules are
protocol plumbing your MCP SDK owns: upgrading to a release that targets
${TARGET_REVISION} resolves them with no change to your own code. Only
${application.map((r) => `[${r.id}](${r.id}.md)`).join(', ')} can ever be
something you wrote.

So the order to work in is fixed: upgrade the SDK, re-run the check, and then
look at what is left — rather than reading a list of eighteen findings, most of
which describe code you did not write.

## Breaking

A server failing any of these will not work with 2026-07-28 clients.

| Rule | Severity | Check | Fixed by | Transports |
| --- | --- | --- | --- | --- |
${errors.map(row).join('\n')}

## Deprecations and advisories

These still work today, but are scheduled for removal or degrade behaviour.

| Rule | Severity | Check | Fixed by | Transports |
| --- | --- | --- | --- | --- |
${warnings.map(row).join('\n')}

## Not yet covered

Some 2026-07-28 changes need an auth flow or an interactive scenario to probe
properly, and are deliberately left out rather than checked unreliably:

- Multi Round-Trip Requests (\`InputRequiredResult\`) conformance — SEP-2322
- Migration of tasks to the \`io.modelcontextprotocol/tasks\` extension — SEP-2663
- RFC 9207 \`iss\` validation in authorization responses — SEP-2468
- Client ID Metadata Documents replacing Dynamic Client Registration

Each has a tracking issue. Contributions welcome — see
[CONTRIBUTING.md](../../CONTRIBUTING.md).

---

*Generated by \`scripts/gen-rule-docs.mjs\`. Edit the rule sources, not this page.*
`;
}

const files = readdirSync(rulesDir)
  .filter((f) => /^MCP\d{3}\.ts$/.test(f))
  .sort();

if (files.length === 0) {
  console.error('No rule files found.');
  process.exit(1);
}

const rules = files.map((file) =>
  extract(readFileSync(join(rulesDir, file), 'utf8'), file),
);

if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

const outputs = [
  ...rules.map((rule) => [join(docsDir, `${rule.id}.md`), page(rule)]),
  [join(docsDir, 'README.md'), index(rules)],
];

let stale = 0;
for (const [path, content] of outputs) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing === content) continue;
  stale += 1;
  if (check) {
    console.error(`out of date: ${path.slice(root.length + 1)}`);
  } else {
    writeFileSync(path, content, 'utf8');
  }
}

if (check && stale > 0) {
  console.error(`\n${stale} rule doc(s) out of date. Run: npm run docs:rules`);
  process.exit(1);
}

console.log(
  check
    ? `Rule docs are up to date (${rules.length} rules).`
    : `Wrote ${outputs.length} file(s) for ${rules.length} rules.`,
);
