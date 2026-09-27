# index-data

Results of the weekly [compliance index](https://github.com/Khanthtutzin/mcp-stateless/blob/main/.github/workflows/index.yml).
Written only by the workflow's `commit` job. This branch's git log is the audit trail.

- `index/runs/<date>.json` — one snapshot per scan: verdicts and rule ids only, no wire traffic
- `index/history.json` — append-only trend, one row per scan date

The cohort itself (`index/targets.json`) lives on `main`.
