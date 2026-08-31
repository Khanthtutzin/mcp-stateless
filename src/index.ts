/**
 * Programmatic entry point.
 *
 * The CLI is a thin wrapper over this, so anything `mcp-stateless` can do from a
 * terminal can also be done from a test suite or a custom harness.
 */
export { runChecks, type RunOptions, type RunReport, type RuleOutcome } from './run.js';
export { StdioTransport, tokenizeCommand } from './transport/stdio.js';
export { planSpawn, type SpawnPlan } from './transport/spawn-plan.js';
export { HttpTransport } from './transport/http.js';
export type {
  Transport,
  Exchange,
  JsonRpcRequest,
  JsonRpcResponse,
  SendOptions,
} from './transport/types.js';
export {
  createProbeContext,
  effectiveToolsList,
  succeeded,
  errorCode,
  isMethodNotFound,
  resultOf,
  type ProbeContext,
  type Prelude,
} from './probe/context.js';
export { ALL_RULES, rulesFor, ruleById } from './rules/index.js';
export type {
  Rule,
  Finding,
  Severity,
  Remediation,
  TransportKind,
} from './rules/types.js';
export { renderTerminal } from './report/terminal.js';
export { renderJson, toJsonReport, type JsonReport } from './report/json.js';
export { renderSarif } from './report/sarif.js';
export { renderMarkdown } from './report/markdown.js';
export {
  TARGET_REVISION,
  LEGACY_REVISIONS,
  META,
  HTTP_HEADERS,
  ERROR_CODES,
  specUrl,
} from './protocol.js';
