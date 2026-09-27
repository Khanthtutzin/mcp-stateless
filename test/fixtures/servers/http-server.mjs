/**
 * Fixture MCP server on Streamable HTTP.
 *
 * Started in-process by the test suite rather than spawned, so ports are
 * chosen by the OS and cleanup is deterministic.
 *
 * Modes: legacy | modern | strict-params | strict-headers | dual-era |
 *        partial-cache | tools-only | oauth-no-iss | oauth-iss |
 *        oauth-challenge
 */
import { createServer } from 'node:http';
import { createHandler } from './handlers.mjs';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * OAuth discovery documents each oauth-* mode serves, keyed by path. Each mode
 * exercises a different step of the discovery order MCP019 must follow.
 *
 *   oauth-no-iss     root metadata; issuer with a path; flag absent
 *   oauth-iss        path-inserted metadata; issuer without a path, served
 *                    only at the OIDC fallback; flag true
 *   oauth-challenge  metadata named by a 401 challenge; issuer found at the
 *                    third, path-appended candidate; flag false
 */
function oauthDocuments(mode, origin) {
  switch (mode) {
    case 'oauth-no-iss':
      return {
        '/.well-known/oauth-protected-resource': {
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/tenant1`],
        },
        '/.well-known/oauth-authorization-server/tenant1': {
          issuer: `${origin}/tenant1`,
          authorization_endpoint: `${origin}/tenant1/authorize`,
          token_endpoint: `${origin}/tenant1/token`,
        },
      };
    case 'oauth-iss':
      return {
        '/.well-known/oauth-protected-resource/mcp': {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        },
        '/.well-known/openid-configuration': {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          authorization_response_iss_parameter_supported: true,
        },
      };
    case 'oauth-challenge':
      return {
        '/meta/protected-resource': {
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/tenant2`],
        },
        '/tenant2/.well-known/openid-configuration': {
          issuer: `${origin}/tenant2`,
          authorization_endpoint: `${origin}/tenant2/authorize`,
          token_endpoint: `${origin}/tenant2/token`,
          authorization_response_iss_parameter_supported: false,
        },
      };
    default:
      return {};
  }
}

/**
 * @param {import('./http-server.d.mts').FixtureMode} mode
 * @returns {Promise<import('./http-server.d.mts').HttpFixture>}
 */
export async function startHttpFixture(mode) {
  // strict-headers and the oauth-* modes are modern in every respect except
  // their headers and the documents they publish.
  const handle = createHandler(
    mode === 'strict-headers' || mode.startsWith('oauth-') ? 'modern' : mode,
  );
  /** Every metadata GET, with its headers, so tests can see what was sent. */
  const metadataRequests = [];

  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const path = new URL(req.url ?? '/', origin).pathname;

    if (req.method === 'GET' && path !== '/mcp') {
      metadataRequests.push({ path, headers: { ...req.headers } });
      const doc = oauthDocuments(mode, origin)[path];
      res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc ?? { error: 'not_found' }));
      return;
    }

    if (
      mode === 'oauth-challenge' &&
      req.method === 'POST' &&
      req.headers.authorization === undefined
    ) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': `Bearer resource_metadata="${origin}/meta/protected-resource", scope="mcp"`,
      });
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    if (req.method === 'GET') {
      if (mode === 'legacy') {
        // The deprecated HTTP+SSE handshake: an open stream that names a
        // separate POST endpoint.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'mcp-session-id': 'fixture-session-1',
        });
        res.write('event: endpoint\ndata: /messages?sessionId=fixture-session-1\n\n');
        // Left open, as the real transport does.
        return;
      }
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('Method Not Allowed');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    if (mode === 'strict-headers' && req.headers['mcp-method'] !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Unexpected header: Mcp-Method' },
        }),
      );
      return;
    }

    let request;
    try {
      request = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
      return;
    }

    // Legacy servers validated the routing header against the body and used
    // the pre-renumbering HeaderMismatch code.
    const declaredMethod = req.headers['mcp-method'];
    if (mode === 'legacy' && declaredMethod && declaredMethod !== request.method) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: {
            code: -32001,
            message: `Header mismatch: Mcp-Method ${declaredMethod} != ${request.method}`,
          },
        }),
      );
      return;
    }

    const response = handle(request);
    const headers = { 'content-type': 'application/json' };
    // The removed session header, which MCP003 looks for.
    if (mode === 'legacy') headers['mcp-session-id'] = 'fixture-session-1';

    if (!response) {
      res.writeHead(202, headers).end();
      return;
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify(response));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    metadataRequests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
