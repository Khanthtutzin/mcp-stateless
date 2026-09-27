/**
 * Request handlers for the fixture servers.
 *
 * These are deliberately hand-written rather than built on an SDK. The whole
 * point is to reproduce specific pre-2026 behaviours exactly, including the
 * wrong ones, which an up-to-date SDK would refuse to emit.
 *
 * Modes:
 *   legacy         a 2025-11-25 server: stateful, removed methods still live
 *   modern         a clean 2026-07-28 server
 *   strict-params  modern, but rejects any request carrying params._meta
 *   dual-era       modern, but also still answers the legacy initialize
 *   partial-cache  modern, but prompts/list and resources/read lack the
 *                  SEP-2549 cache fields that tools/list carries
 *   tools-only     modern, with no prompts or resources at all
 *   core-tasks     modern, but still declares tasks in core capabilities
 *                  rather than the io.modelcontextprotocol/tasks extension
 *   core-and-ext   modern, declaring both: the extension and a stale core key
 *   tasks-ext      modern, advertising the tasks extension
 *   hidden-tasks   modern, serving tasks/get while advertising no tasks at all
 *   list-changed   modern, advertising tools.listChanged in server/discover
 *   silent-listen  list-changed, but subscriptions/listen is held open with no
 *                  acknowledgement at all
 *
 * A handler returns a response, null for a notification, or { hold: [...] }:
 * write those notifications and keep the request open, never answering it.
 */

const TOOLS = [
  { name: 'alpha', description: 'First tool.', inputSchema: { type: 'object' } },
  { name: 'beta', description: 'Second tool.', inputSchema: { type: 'object' } },
];

const PROMPTS = [{ name: 'greet', description: 'Say hello.' }];

const RESOURCE = {
  uri: 'fixture://notes/readme',
  name: 'readme',
  mimeType: 'text/plain',
};

const TEMPLATES = [
  { uriTemplate: 'fixture://notes/{name}', name: 'note', mimeType: 'text/plain' },
];

/** The 2025-11-25 core tasks capability, removed from core in 2026-07-28. */
const CORE_TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } };
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** Modes that serve some task method at all. */
const SERVES_TASKS = new Set([
  'legacy',
  'core-tasks',
  'core-and-ext',
  'tasks-ext',
  'hidden-tasks',
]);

/** What server/discover advertises, which is where the tasks modes differ. */
function discoverCapabilities(mode) {
  const base = { tools: {}, prompts: {}, resources: {} };
  const extension = { extensions: { [TASKS_EXTENSION]: {} } };
  switch (mode) {
    case 'core-tasks':
      return { ...base, tasks: CORE_TASKS_CAPABILITY };
    case 'core-and-ext':
      return { ...base, tasks: CORE_TASKS_CAPABILITY, ...extension };
    case 'tasks-ext':
      return { ...base, ...extension };
    case 'list-changed':
    case 'silent-listen':
      return { ...base, tools: { listChanged: true } };
    default:
      return base;
  }
}

const SERVER_INFO = { name: 'mcp-stateless-fixture', version: '1.0.0' };
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Oldest revision the legacy fixture claims to understand. */
const LEGACY_FLOOR = '2025-03-26';

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The CacheableResult fields (SEP-2549) a modern list or read result carries. */
function cacheable() {
  return {
    ttlMs: 60_000,
    cacheScope: 'public',
    _meta: { [META_SERVER_INFO]: SERVER_INFO },
  };
}

/** Methods the partial-cache fixture still answers without the SEP-2549 fields. */
const PARTIAL_CACHE_STALE = new Set(['prompts/list', 'resources/read']);

/**
 * A prompts or resources result as `mode` would shape it: bare for legacy,
 * and complete with the cache fields otherwise — except where partial-cache
 * deliberately leaves them off.
 */
function cacheableResult(mode, method, body) {
  if (mode === 'legacy') return body;
  const stale = mode === 'partial-cache' && PARTIAL_CACHE_STALE.has(method);
  return { resultType: 'complete', ...body, ...(stale ? {} : cacheable()) };
}

function metaVersion(request) {
  return request?.params?._meta?.[META_PROTOCOL_VERSION];
}

export function createHandler(mode) {
  // Session state, which is exactly what 2026-07-28 removed. Only the legacy
  // fixture consults it.
  let initialized = false;
  // Drives the non-deterministic ordering the legacy fixture exhibits.
  let listCount = 0;

  return function handle(request) {
    const { id, method } = request;
    if (id === undefined || id === null) return null; // notification

    if (mode === 'strict-params' && request.params?._meta !== undefined) {
      return fail(id, -32602, 'Invalid params: unexpected property "_meta".');
    }

    if (mode === 'legacy') {
      if (method === 'initialize') {
        initialized = true;
        return ok(id, {
          protocolVersion: '2025-11-25',
          capabilities: {
            tools: { listChanged: true },
            resources: { subscribe: true },
            logging: {},
            tasks: CORE_TASKS_CAPABILITY,
          },
          serverInfo: SERVER_INFO,
        });
      }
      if (!initialized) {
        return fail(id, -32600, 'Server not initialized. Call initialize first.');
      }
      // Legacy servers accept revisions newer than themselves and reject
      // anything older than the floor they were written against.
      const version = metaVersion(request);
      if (typeof version === 'string' && version < LEGACY_FLOOR) {
        return fail(id, -32004, `Unsupported protocol version: ${version}`);
      }
    } else {
      if (method === 'initialize') {
        // Dual-era servers keep serving pre-2026 clients through the
        // deprecation window while fully supporting 2026-07-28.
        if (mode === 'dual-era') {
          return ok(id, {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          });
        }
        return fail(
          id,
          -32601,
          'Method not found: initialize was removed in 2026-07-28.',
        );
      }
      const version = metaVersion(request);
      if (typeof version === 'string' && version !== '2026-07-28') {
        return fail(id, -32022, `Unsupported protocol version: ${version}`);
      }
    }

    if (
      mode === 'tools-only' &&
      (method.startsWith('prompts/') || method.startsWith('resources/'))
    ) {
      return fail(id, -32601, `Method not found: ${method}`);
    }

    switch (method) {
      case 'server/discover':
        if (mode === 'legacy')
          return fail(id, -32601, 'Method not found: server/discover');
        // Shape mirrors DiscoverResult in the 2026-07-28 schema: the field is
        // supportedVersions, and identity lives in _meta rather than at the
        // top level. Verified against the spec's own conformance corpus.
        return ok(id, {
          resultType: 'complete',
          supportedVersions: ['2026-07-28'],
          capabilities: discoverCapabilities(mode),
          ttlMs: 3_600_000,
          cacheScope: 'public',
          _meta: { [META_SERVER_INFO]: SERVER_INFO },
        });

      case 'tools/list': {
        listCount += 1;
        if (mode === 'legacy') {
          // Iteration order that flips between calls, the way a Map or Set
          // rebuilt per request often does.
          const tools = listCount % 2 === 0 ? [...TOOLS].reverse() : [...TOOLS];
          return ok(id, { tools });
        }
        return ok(id, {
          resultType: 'complete',
          tools: [...TOOLS].sort((a, b) => a.name.localeCompare(b.name)),
          ttlMs: 60_000,
          cacheScope: 'public',
          _meta: { [META_SERVER_INFO]: SERVER_INFO },
        });
      }

      // The other CacheableResult methods. Legacy results predate SEP-2549 and
      // carry neither ttlMs nor cacheScope — what MCP005 looks for.
      case 'prompts/list':
        return ok(id, cacheableResult(mode, method, { prompts: PROMPTS }));

      case 'resources/list':
        return ok(id, cacheableResult(mode, method, { resources: [RESOURCE] }));

      case 'resources/templates/list':
        return ok(id, cacheableResult(mode, method, { resourceTemplates: TEMPLATES }));

      case 'resources/read': {
        if (request.params?.uri === RESOURCE.uri) {
          const contents = [{ uri: RESOURCE.uri, mimeType: 'text/plain', text: 'hi' }];
          return ok(id, cacheableResult(mode, method, { contents }));
        }
        return mode === 'legacy'
          ? fail(id, -32002, 'Resource not found')
          : fail(id, -32602, 'Resource not found');
      }

      // Tasks. 2026-07-28 removed tasks/list and the blocking tasks/result
      // with the move to the extension; tasks/get survives in it. Only the
      // legacy fixture still serves the removed pair.
      case 'tasks/list':
        return mode === 'legacy'
          ? ok(id, { tasks: [] })
          : fail(id, -32601, `Method not found: ${method}`);

      case 'tasks/result':
        return mode === 'legacy'
          ? fail(id, -32602, 'Task not found')
          : fail(id, -32601, `Method not found: ${method}`);

      case 'tasks/get':
        return SERVES_TASKS.has(mode)
          ? fail(id, -32602, 'Task not found')
          : fail(id, -32601, `Method not found: ${method}`);

      case 'ping':
        return mode === 'legacy'
          ? ok(id, {})
          : fail(id, -32601, 'Method not found: ping');

      case 'logging/setLevel':
        return mode === 'legacy'
          ? ok(id, {})
          : fail(id, -32601, 'Method not found: logging/setLevel');

      case 'resources/subscribe':
      case 'resources/unsubscribe':
        return mode === 'legacy'
          ? ok(id, {})
          : fail(id, -32601, `Method not found: ${method}`);

      case 'subscriptions/listen':
        // The legacy fixture advertises listChanged but has no way to deliver
        // it under the new protocol — precisely what MCP009 looks for.
        if (mode === 'legacy')
          return fail(id, -32601, 'Method not found: subscriptions/listen');
        // A real listen stream is never answered: the server acknowledges it
        // with a notification tagged by the request id and holds it open, as
        // the 2.1.0 SDK does. silent-listen holds it open and says nothing.
        return {
          hold:
            mode === 'silent-listen'
              ? []
              : [
                  {
                    jsonrpc: '2.0',
                    method: 'notifications/subscriptions/acknowledged',
                    params: {
                      notifications: request.params?.notifications ?? {},
                      _meta: { 'io.modelcontextprotocol/subscriptionId': id },
                    },
                  },
                ],
        };

      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  };
}
