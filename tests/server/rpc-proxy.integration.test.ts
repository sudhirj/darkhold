import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

type SseEvent = { id: number | null; data: string };

type IntegrationServer = {
  server: ChildProcess;
  tempRoot: string;
  httpPort: number;
};

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

async function postRpc<T>(port: number, method: string, params?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const payload = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
  }
  return payload as T;
}

async function openThreadSse(port: number, threadId: string, options?: { lastEventId?: number }): Promise<Response> {
  const headers = options?.lastEventId !== undefined ? { 'last-event-id': String(options.lastEventId) } : undefined;
  const response = await fetch(
    `http://127.0.0.1:${port}/api/thread/events/stream?threadId=${encodeURIComponent(threadId)}`,
    headers ? { headers } : undefined,
  );
  if (!response.ok) {
    throw new Error(`failed to open sse stream: HTTP ${response.status}`);
  }
  return response;
}

async function waitForSseEvent(
  response: Response,
  predicate: (event: SseEvent) => boolean,
  timeoutMs = 15_000,
): Promise<SseEvent> {
  const body = response.body;
  if (!body) {
    throw new Error('missing sse body');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  const parseFrame = (frame: string): SseEvent | null => {
    const lines = frame.split('\n');
    let id: number | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) {
        continue;
      }
      if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice(3).trim(), 10);
        id = Number.isFinite(parsed) ? parsed : null;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      return null;
    }
    return { id, data: dataLines.join('\n') };
  };

  while (Date.now() < deadline) {
    const timeoutMsRemaining = deadline - Date.now();
    const readResult = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sse read timeout')), timeoutMsRemaining)),
    ]);
    if (readResult.done) {
      throw new Error('sse stream closed');
    }
    buffer += decoder.decode(readResult.value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (!parsed) {
        continue;
      }
      if (predicate(parsed)) {
        return parsed;
      }
    }
  }

  throw new Error('sse event timeout');
}

function parseSseJson(event: SseEvent): any {
  return JSON.parse(event.data);
}

async function acceptNextApproval(port: number, threadId: string, sse: Response): Promise<void> {
  const interactionEvent = await waitForSseEvent(sse, (event) => {
    try {
      const parsed = parseSseJson(event);
      return parsed.method === 'darkhold/interaction/request' && parsed.params?.threadId === threadId;
    } catch {
      return false;
    }
  });
  const interactionPayload = parseSseJson(interactionEvent);
  const requestId = String(interactionPayload.params?.requestId ?? '');
  if (!requestId) {
    throw new Error('missing requestId');
  }

  const response = await fetch(`http://127.0.0.1:${port}/api/thread/interaction/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ threadId, requestId, result: { decision: 'accept' } }),
  });
  if (!response.ok) {
    const payload = (await response.json()) as any;
    throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
  }
}

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
let initialized = false;
let pendingApprovalRequestId = null;
let pendingApprovalThreadId = null;
let pendingApprovalTurnId = null;
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
if (process.argv[2] !== 'app-server') { process.exit(2); }
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.id === 'number' && typeof msg.method !== 'string') {
    if (pendingApprovalRequestId !== null && msg.id === pendingApprovalRequestId) {
      const approvalThreadId = pendingApprovalThreadId || threadId || ('thread-' + process.pid);
      const approvalTurnId = pendingApprovalTurnId || 'turn-' + (turnCounter || 1);
      send({ method: 'item/agentMessage/delta', params: { threadId: approvalThreadId, turnId: approvalTurnId, delta: 'delta-from-' + process.pid } });
      turns.push({
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
          { type: 'agentMessage', text: 'response-' + process.pid },
        ],
      });
      updatedAt = Math.floor(Date.now() / 1000);
      send({ method: 'turn/completed', params: { threadId: approvalThreadId, turnId: approvalTurnId, turn: { id: approvalTurnId, status: 'completed', error: null } } });
      pendingApprovalRequestId = null;
      pendingApprovalThreadId = null;
      pendingApprovalTurnId = null;
    }
    return;
  }
  if (typeof msg.method !== 'string') { return; }
  const id = msg.id;
  const p = msg.params || {};
  if (msg.method === 'initialize') {
    if (initialized) {
      send({ id, error: { message: 'Already initialized' } });
      return;
    }
    initialized = true;
    send({ id, result: {} });
    return;
  }
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
    pendingApprovalRequestId = 7000 + turnCounter;
    pendingApprovalThreadId = activeThreadId;
    pendingApprovalTurnId = turnId;
    setTimeout(() => {
      if (pendingApprovalRequestId !== null) {
        send({
          id: pendingApprovalRequestId,
          method: 'execCommandApproval',
          params: { threadId: activeThreadId, command: 'echo from-fake-codex' },
        });
      }
    }, 20);
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

      const started = await postRpc<{ thread: { id: string } }>(instance.httpPort, 'thread/start', { cwd: instance.tempRoot });
      const sse = await openThreadSse(instance.httpPort, started.thread.id);
      await postRpc<{ ok: boolean }>(instance.httpPort, 'turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'hi' }] });
      await acceptNextApproval(instance.httpPort, started.thread.id, sse);
      await waitForSseEvent(sse, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'turn/completed' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });

      await postRpc('thread/read', { threadId: started.thread.id, includeTurns: true });
      const response = await fetch(
        `http://127.0.0.1:${instance.httpPort}/api/thread/events?threadId=${encodeURIComponent(started.thread.id)}`,
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { events: string[] };
      expect(body.events.length).toBeGreaterThan(0);
      expect(body.events.some((line) => line.includes('"method":"darkhold/thread-event"'))).toBe(true);
    },
    25_000,
  );

  it(
    'broadcasts thread events to multiple SSE clients and continues after reconnect',
    async () => {
      if (!(await canUseLoopbackSockets())) {
        return;
      }
      const instance = await startIntegrationServer();
      servers.push(instance);

      const started = await postRpc<{ thread: { id: string } }>(instance.httpPort, 'thread/start', { cwd: instance.tempRoot });
      const sse1 = await openThreadSse(instance.httpPort, started.thread.id);
      const sse2 = await openThreadSse(instance.httpPort, started.thread.id);

      await postRpc<{ ok: boolean }>(instance.httpPort, 'turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'first turn' }],
      });
      await acceptNextApproval(instance.httpPort, started.thread.id, sse1);

      const delta1 = await waitForSseEvent(sse1, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'item/agentMessage/delta' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });
      const delta2 = await waitForSseEvent(sse2, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'item/agentMessage/delta' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });
      expect(String(parseSseJson(delta1).params?.delta)).toContain('delta-from-');
      expect(String(parseSseJson(delta2).params?.delta)).toContain('delta-from-');

      const sse2LastId = delta2.id ?? 1;
      const sse2Reconnect = await openThreadSse(instance.httpPort, started.thread.id, { lastEventId: sse2LastId });

      await postRpc<{ ok: boolean }>(instance.httpPort, 'turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'second turn' }],
      });
      await acceptNextApproval(instance.httpPort, started.thread.id, sse1);

      const deltaAfterReconnect1 = await waitForSseEvent(sse1, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'item/agentMessage/delta' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });
      const deltaAfterReconnect2 = await waitForSseEvent(sse2Reconnect, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'item/agentMessage/delta' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });
      expect(String(parseSseJson(deltaAfterReconnect1).params?.delta)).toContain('delta-from-');
      expect(String(parseSseJson(deltaAfterReconnect2).params?.delta)).toContain('delta-from-');
    },
    25_000,
  );

  it(
    'allows turn/start from separate HTTP callers on same thread',
    async () => {
      if (!(await canUseLoopbackSockets())) {
        return;
      }
      const instance = await startIntegrationServer();
      servers.push(instance);

      const started = await postRpc<{ thread: { id: string } }>(instance.httpPort, 'thread/start', { cwd: instance.tempRoot });
      const sse = await openThreadSse(instance.httpPort, started.thread.id);

      const first = await postRpc<{ ok: boolean }>(instance.httpPort, 'turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'first' }],
      });
      expect(first.ok).toBe(true);
      await acceptNextApproval(instance.httpPort, started.thread.id, sse);
      await waitForSseEvent(sse, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'turn/completed' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });

      const second = await postRpc<{ ok: boolean }>(instance.httpPort, 'turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'second' }],
      });
      expect(second.ok).toBe(true);
      await acceptNextApproval(instance.httpPort, started.thread.id, sse);
      await waitForSseEvent(sse, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'turn/completed' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });
    },
    25_000,
  );

  it(
    'broadcasts approval requests to all SSE clients and accepts first response',
    async () => {
      if (!(await canUseLoopbackSockets())) {
        return;
      }
      const instance = await startIntegrationServer();
      servers.push(instance);

      const started = await postRpc<{ thread: { id: string } }>(instance.httpPort, 'thread/start', { cwd: instance.tempRoot });
      const sse1 = await openThreadSse(instance.httpPort, started.thread.id);
      const sse2 = await openThreadSse(instance.httpPort, started.thread.id);

      await postRpc<{ ok: boolean }>(instance.httpPort, 'turn/start', {
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'needs approval' }],
      });

      const approval1 = await waitForSseEvent(sse1, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'darkhold/interaction/request' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });
      const approval2 = await waitForSseEvent(sse2, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'darkhold/interaction/request' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });

      const requestId = String(parseSseJson(approval2).params?.requestId ?? '');
      expect(requestId.length).toBeGreaterThan(0);

      const accepted = await fetch(`http://127.0.0.1:${instance.httpPort}/api/thread/interaction/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: started.thread.id, requestId, result: { decision: 'accept' } }),
      });
      expect(accepted.ok).toBe(true);

      const duplicate = await fetch(`http://127.0.0.1:${instance.httpPort}/api/thread/interaction/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ threadId: started.thread.id, requestId, result: { decision: 'accept' } }),
      });
      expect(duplicate.status).toBe(409);

      await waitForSseEvent(sse1, (event) => {
        try {
          const parsed = parseSseJson(event);
          return parsed.method === 'turn/completed' && parsed.params?.threadId === started.thread.id;
        } catch {
          return false;
        }
      });

      expect(approval1.id).not.toBe(null);
      expect(approval2.id).not.toBe(null);
    },
    25_000,
  );
});
