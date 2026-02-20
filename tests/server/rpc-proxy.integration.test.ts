import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string };
};

class RpcWsClient {
  private ws: WebSocket;

  private nextId = 1;

  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  readonly notifications: JsonRpcMessage[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const text = raw.toString();
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(text) as JsonRpcMessage;
      } catch {
        return;
      }
      if (typeof parsed.id === 'number' && (parsed.result !== undefined || parsed.error)) {
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          return;
        }
        this.pending.delete(parsed.id);
        if (parsed.error) {
          pending.reject(new Error(parsed.error.message ?? 'RPC error'));
          return;
        }
        pending.resolve(parsed.result);
        return;
      }
      if (typeof parsed.method === 'string') {
        this.notifications.push(parsed);
      }
    });
  }

  waitOpen(timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('websocket open timeout')), timeoutMs);
      this.ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    this.ws.send(payload);
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15_000);
    });
  }

  async waitForNotification(
    predicate: (message: JsonRpcMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<JsonRpcMessage> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const found = this.notifications.find(predicate);
      if (found) {
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('notification timeout');
  }

  close() {
    this.ws.close();
  }
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to pick free port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function canUseLoopbackSockets(): Promise<boolean> {
  try {
    await pickFreePort();
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server health timeout');
}

type IntegrationServer = {
  server: ChildProcess;
  tempRoot: string;
  httpPort: number;
};

async function startIntegrationServer(): Promise<IntegrationServer> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'darkhold-it-'));
  const fakeBinDir = path.join(tempRoot, 'bin');
  await mkdir(fakeBinDir, { recursive: true });

  const codexPath = path.join(fakeBinDir, 'codex');
  const codexScript = `#!/usr/bin/env node
const readline = require('node:readline');
let threadId = null;
let cwd = '/tmp';
let updatedAt = Math.floor(Date.now() / 1000);
const turns = [];
let turnCounter = 0;
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
if (process.argv[2] !== 'app-server') { process.exit(2); }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.method !== 'string') { return; }
  const id = msg.id;
  const p = msg.params || {};
  if (msg.method === 'initialize') { send({ id, result: {} }); return; }
  if (msg.method === 'thread/start') {
    threadId = threadId || ('thread-' + process.pid);
    cwd = typeof p.cwd === 'string' ? p.cwd : cwd;
    updatedAt = Math.floor(Date.now() / 1000);
    send({ id, result: { thread: { id: threadId, cwd, updatedAt } } });
    return;
  }
  if (msg.method === 'thread/list') {
    const data = threadId ? [{ id: threadId, cwd, updatedAt }] : [];
    send({ id, result: { data } });
    return;
  }
  if (msg.method === 'thread/read' || msg.method === 'thread/resume') {
    const requestedId = typeof p.threadId === 'string' ? p.threadId : threadId;
    send({ id, result: { thread: { id: requestedId || ('thread-' + process.pid), cwd, updatedAt, turns } } });
    return;
  }
  if (msg.method === 'turn/start') {
    turnCounter += 1;
    const activeThreadId = typeof p.threadId === 'string' ? p.threadId : (threadId || ('thread-' + process.pid));
    threadId = activeThreadId;
    const turnId = 'turn-' + turnCounter;
    send({ id, result: { ok: true } });
    send({ method: 'turn/started', params: { threadId: activeThreadId, turnId, turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'item/agentMessage/delta', params: { threadId: activeThreadId, turnId, delta: 'delta-from-' + process.pid } });
    }, 40);
    setTimeout(() => {
      turns.push({
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
          { type: 'agentMessage', text: 'response-' + process.pid },
        ],
      });
      updatedAt = Math.floor(Date.now() / 1000);
      send({ method: 'turn/completed', params: { threadId: activeThreadId, turnId, turn: { id: turnId, status: 'completed', error: null } } });
    }, 220);
    return;
  }
  send({ id, result: {} });
});
`;
  await writeFile(codexPath, codexScript, { mode: 0o755 });

  const httpPort = await pickFreePort();
  const rpcPort = await pickFreePort();
  const env = {
    ...process.env,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
  };
  const server = spawn(
    process.execPath,
    ['run', 'src/server/index.ts', '--', '--bind', '127.0.0.1', '--port', String(httpPort), '--rpc-port', String(rpcPort), '--base-path', tempRoot],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  await waitForHealth(httpPort);
  return { server, tempRoot, httpPort };
}

async function stopIntegrationServer(instance: IntegrationServer): Promise<void> {
  instance.server.kill('SIGTERM');
  await new Promise((resolve) => {
    instance.server.once('exit', () => resolve(null));
    setTimeout(() => resolve(null), 2_000);
  });
  await rm(instance.tempRoot, { recursive: true, force: true });
}

const servers: IntegrationServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => stopIntegrationServer(server)));
});

describe('rpc proxy integration', () => {
  it(
    'rehydrates thread event cache from thread/read and serves it over HTTP',
    async () => {
      if (!(await canUseLoopbackSockets())) {
        return;
      }
      const instance = await startIntegrationServer();
      servers.push(instance);

      const ws = new RpcWsClient(`ws://127.0.0.1:${instance.httpPort}/api/rpc/ws`);
      await ws.waitOpen();
      await ws.request('initialize', { clientInfo: { name: 'it', title: 'it', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      const started = await ws.request<{ thread: { id: string } }>('thread/start', { cwd: instance.tempRoot });
      await ws.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hi' }] });
      await ws.waitForNotification((m) => m.method === 'turn/completed' && m.params?.threadId === started.thread.id);
      await ws.request('thread/read', { threadId: started.thread.id, includeTurns: true });

      const response = await fetch(
        `http://127.0.0.1:${instance.httpPort}/api/thread/events?threadId=${encodeURIComponent(started.thread.id)}`,
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { events: string[] };
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.some((line) => line.includes('"method":"darkhold/thread-event"'))).toBe(true);

      ws.close();
    },
    25_000,
  );

  it(
    'routes same thread to one session and broadcasts events to multiple clients',
    async () => {
      if (!(await canUseLoopbackSockets())) {
        return;
      }
      const instance = await startIntegrationServer();
      servers.push(instance);

      const ws1 = new RpcWsClient(`ws://127.0.0.1:${instance.httpPort}/api/rpc/ws`);
      await ws1.waitOpen();
      await ws1.request('initialize', { clientInfo: { name: 'it1', title: 'it1', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      const started = await ws1.request<{ thread: { id: string } }>('thread/start', { cwd: instance.tempRoot });

      const ws2 = new RpcWsClient(
        `ws://127.0.0.1:${instance.httpPort}/api/rpc/ws?threadId=${encodeURIComponent(started.thread.id)}`,
      );
      await ws2.waitOpen();
      await ws2.request('initialize', { clientInfo: { name: 'it2', title: 'it2', version: '0.0.0' }, capabilities: { experimentalApi: true } });
      await ws2.request('thread/resume', { threadId: started.thread.id });

      await ws1.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hello' }] });

      const n1 = await ws1.waitForNotification(
        (m) => m.method === 'item/agentMessage/delta' && m.params?.threadId === started.thread.id,
      );
      const n2 = await ws2.waitForNotification(
        (m) => m.method === 'item/agentMessage/delta' && m.params?.threadId === started.thread.id,
      );

      expect(String(n1.params?.delta)).toContain('delta-from-');
      expect(String(n2.params?.delta)).toContain('delta-from-');

      ws1.close();
      ws2.close();
    },
    25_000,
  );
});
