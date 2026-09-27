/**
 * Fixture MCP server on Streamable HTTP.
 *
 * Started in-process by the test suite rather than spawned, so ports are
 * chosen by the OS and cleanup is deterministic.
 *
 * Modes: legacy | modern | strict-params | strict-headers | dual-era |
 *        partial-cache | tools-only
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
 * @param {import('./http-server.d.mts').FixtureMode} mode
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startHttpFixture(mode) {
  // strict-headers is modern in every respect except its header handling.
  const handle = createHandler(mode === 'strict-headers' ? 'modern' : mode);

  const server = createServer(async (req, res) => {
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
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
