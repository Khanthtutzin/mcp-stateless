import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { planSpawn } from './spawn-plan.js';
import type {
  Exchange,
  JsonRpcRequest,
  JsonRpcResponse,
  SendOptions,
  Transport,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Split a shell-ish command string into argv, honouring single and double
 * quotes and backslash escapes.
 *
 * We tokenize rather than passing `shell: true` so that the same command
 * string behaves identically on Windows and POSIX, and so a stray shell
 * metacharacter in a user's server command cannot be interpreted.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
      const next = command[i + 1]!;
      // Outside single quotes a backslash escapes the next character. On
      // Windows paths this would mangle `C:\foo`, so only treat it as an
      // escape when it precedes a character that actually needs escaping.
      if (next === '"' || next === "'" || next === '\\' || next === ' ') {
        current += next;
        i++;
        hasContent = true;
        continue;
      }
      current += ch;
      hasContent = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      hasContent = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasContent = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }

    current += ch;
    hasContent = true;
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote in command: ${command}`);
  }
  if (hasContent) tokens.push(current);
  return tokens;
}

interface Pending {
  resolve: (response: JsonRpcResponse) => void;
  timer: NodeJS.Timeout;
}

/**
 * Newline-delimited JSON-RPC over a child process's stdin/stdout.
 *
 * Under 2026-07-28 stdio remains a supported transport, but it is now stateless
 * in the same way HTTP is: no handshake, and `server/discover` doubles as the
 * backward-compatibility probe.
 */
export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  readonly target: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string | number, Pending>();
  private readonly notes: string[] = [];
  private stdoutBuffer = '';
  private nextId = 1;
  private exited = false;

  constructor(
    private readonly command: string,
    private readonly cwd?: string,
  ) {
    this.target = command;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const argv = tokenizeCommand(this.command);
    if (!argv[0]) throw new Error('Empty --stdio command.');

    // Never `shell: true` — that would reinterpret metacharacters in a
    // user-supplied command. `planSpawn` resolves the executable itself and
    // routes Windows batch shims (`npx.cmd` and friends) through cmd.exe with
    // arguments we quote. See src/transport/spawn-plan.ts.
    const plan = planSpawn(argv);
    if (plan.note) this.notes.push(`[spawn] ${plan.note}`);

    const child = spawn(plan.file, plan.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // A write to an ended or broken pipe fails asynchronously, so the
    // try/catch around `stdin.write` below cannot see it. Without a listener
    // here that error is uncaught and takes the whole process down — reachable
    // whenever a caller closes the transport while a run is still in flight,
    // which is exactly what a timeout or a per-target budget does.
    child.stdin.on('error', (err: Error) => {
      this.notes.push(`[stdin] ${err.message}`);
    });

    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) this.notes.push(`[stderr] ${text}`);
    });
    child.on('error', (err: Error) => {
      this.exited = true;
      this.notes.push(`[spawn error] ${err.message}`);
      this.failAllPending(`Failed to start server process: ${err.message}`);
    });
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.notes.push(`[exit] code=${code} signal=${signal ?? 'none'}`);
      this.failAllPending(
        `Server process exited (code=${code}, signal=${signal ?? 'none'}) before responding.`,
      );
    });

    this.child = child;
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;

      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(line) as JsonRpcResponse;
      } catch {
        // Servers that log to stdout corrupt the stream. Worth surfacing —
        // it breaks every client, not just ours.
        this.notes.push(`[non-JSON stdout] ${line.slice(0, 200)}`);
        continue;
      }

      if (parsed.id === undefined || parsed.id === null) {
        this.notes.push(`[notification] ${line.slice(0, 200)}`);
        continue;
      }

      const waiter = this.pending.get(parsed.id);
      if (!waiter) {
        this.notes.push(`[unmatched response id=${String(parsed.id)}]`);
        continue;
      }
      clearTimeout(waiter.timer);
      this.pending.delete(parsed.id);
      waiter.resolve(parsed);
    }
  }

  /**
   * Resolve every in-flight request with a synthetic error response. Callers
   * always get an `Exchange`; `send` converts these into `transportError`.
   */
  private failAllPending(reason: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve({
        jsonrpc: '2.0',
        id,
        error: { code: 0, message: `__transport__:${reason}` },
      });
    }
    this.pending.clear();
  }

  async send(request: JsonRpcRequest, options: SendOptions = {}): Promise<Exchange> {
    const started = Date.now();
    const base: Omit<Exchange, 'response' | 'timingMs'> = {
      request,
      requestHeaders: {},
      responseHeaders: {},
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureStarted();
    } catch (err) {
      return {
        ...base,
        response: null,
        timingMs: Date.now() - started,
        transportError: (err as Error).message,
      };
    }

    if (this.exited) {
      return {
        ...base,
        response: null,
        timingMs: Date.now() - started,
        transportError: 'Server process is no longer running.',
      };
    }

    // Checked before building the request, so an abandoned run that outlived
    // its transport gets an ordinary transport error rather than a late
    // asynchronous stream failure.
    if (child.stdin.writableEnded || child.stdin.destroyed) {
      return {
        ...base,
        response: null,
        timingMs: Date.now() - started,
        transportError: 'Transport was closed before this request was sent.',
      };
    }

    const id = options.notification ? undefined : (request.id ?? this.nextId++);
    const wire: JsonRpcRequest = { ...request, jsonrpc: '2.0' };
    if (id === undefined) delete wire.id;
    else wire.id = id;

    const sent: Exchange['request'] = wire;

    const responsePromise: Promise<JsonRpcResponse | null> = options.notification
      ? Promise.resolve(null)
      : new Promise<JsonRpcResponse>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(id!);
            resolve({
              jsonrpc: '2.0',
              id: id!,
              error: {
                code: 0,
                message: `__transport__:No response within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
              },
            });
          }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
          this.pending.set(id!, { resolve, timer });
        });

    try {
      child.stdin.write(JSON.stringify(wire) + '\n');
    } catch (err) {
      if (id !== undefined) this.pending.delete(id);
      return {
        ...base,
        request: sent,
        response: null,
        timingMs: Date.now() - started,
        transportError: `Could not write to server stdin: ${(err as Error).message}`,
      };
    }

    const response = await responsePromise;
    const timingMs = Date.now() - started;

    // Unwrap the synthetic transport failures produced above.
    if (response?.error?.message.startsWith('__transport__:')) {
      return {
        ...base,
        request: sent,
        response: null,
        timingMs,
        transportError: response.error.message.slice('__transport__:'.length),
      };
    }

    return { ...base, request: sent, response, timingMs };
  }

  diagnostics(): string[] {
    return [...this.notes];
  }

  async close(): Promise<void> {
    this.failAllPending('Transport closed.');
    const child = this.child;
    if (!child || this.exited) return;

    child.stdin.end();
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.kill();
    });
    this.child = null;
  }
}
