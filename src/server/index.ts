import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { getHomeRoot, listFolder, setBrowserRoot } from '../fs/home-browser';
import { createThreadEventLogStore } from './thread-event-log';

type ServerConfig = {
  bind: string;
  port: number;
  rpcPort: number;
  allowCidrs: string[];
  basePath?: string;
};

type AppServerSession = {
  id: number;
  child: ChildProcess;
  stdoutBuffer: string;
  upstreamInitialized: boolean;
  knownThreadIds: Set<string>;
  nextUpstreamRequestId: number;
  pendingClientRequests: Map<
    number,
    {
      method: string;
      resolveHttp?: (payload: any) => void;
      rejectHttp?: (error: Error) => void;
    }
  >;
};

function normalizeRpcPayload(payload: string | ArrayBuffer | Uint8Array): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8');
  }
  return Buffer.from(payload).toString('utf8');
}

function tapRpcFrame(direction: 'client->app-server' | 'app-server->client', payload: string | ArrayBuffer | Uint8Array) {
  if (process.env.DARKHOLD_RPC_TAP !== '1') {
    return;
  }

  const text = normalizeRpcPayload(payload);
  let summary = text;
  try {
    const parsed = JSON.parse(text) as { method?: string; id?: number | string | null };
    if (typeof parsed.method === 'string') {
      summary = `method=${parsed.method}${parsed.id !== undefined ? ` id=${String(parsed.id)}` : ''}`;
    } else if (parsed.id !== undefined) {
      summary = `response id=${String(parsed.id)}`;
    }
  } catch {
    summary = text.length > 240 ? `${text.slice(0, 240)}...` : text;
  }

  console.log(`[rpc tap] ${direction} ${summary}`);
}

function logProxy(message: string) {
  if (process.env.DARKHOLD_RPC_TAP !== '1') {
    return;
  }
  console.log(`[rpc proxy] ${message}`);
}

function parseConfig(argv: string[]): ServerConfig {
  let bind = '127.0.0.1';
  let port = 3275;
  let rpcPort = 3276;
  const allowCidrs: string[] = [];
  let basePath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bind' && argv[i + 1]) {
      bind = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--bind=')) {
      bind = arg.split('=')[1] || bind;
      continue;
    }
    if (arg === '--port' && argv[i + 1]) {
      port = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.split('=')[1] || '', 10);
      continue;
    }
    if (arg === '--rpc-port' && argv[i + 1]) {
      rpcPort = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith('--rpc-port=')) {
      rpcPort = Number.parseInt(arg.split('=')[1] || '', 10);
      continue;
    }
    if (arg === '--allow-cidr' && argv[i + 1]) {
      allowCidrs.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--allow-cidr=')) {
      allowCidrs.push(arg.split('=')[1] || '');
      continue;
    }
    if (arg === '--base-path' && argv[i + 1]) {
      basePath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--base-path=')) {
      basePath = arg.split('=')[1] || basePath;
    }
  }

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Port must be a number between 1 and 65535.');
  }
  if (!Number.isFinite(rpcPort) || rpcPort < 1 || rpcPort > 65535) {
    throw new Error('RPC port must be a number between 1 and 65535.');
  }
  if (port === rpcPort) {
    throw new Error('HTTP server port and RPC server port must be different.');
  }

  for (const cidr of allowCidrs) {
    if (!parseIpv4Cidr(cidr)) {
      throw new Error(`Invalid CIDR: ${cidr}. Expected IPv4 CIDR such as 100.64.0.0/10.`);
    }
  }

  return { bind, port, rpcPort, allowCidrs, basePath };
}

function normalizeIpv4Address(address: string): string | null {
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length);
  }
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return null;
  }
  return parts.join('.');
}

function parseIpv4(value: string): number | null {
  const normalized = normalizeIpv4Address(value);
  if (!normalized) {
    return null;
  }
  const octets = normalized.split('.').map((part) => Number.parseInt(part, 10));
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function parseIpv4Cidr(cidr: string): { network: number; prefix: number } | null {
  const [base, prefixRaw] = cidr.split('/');
  if (!base || !prefixRaw) {
    return null;
  }
  const prefix = Number.parseInt(prefixRaw, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }
  const network = parseIpv4(base);
  if (network === null) {
    return null;
  }
  return { network, prefix };
}

function isLoopback(address: string): boolean {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.');
}

function cidrContains(address: string, cidr: string): boolean {
  const ip = parseIpv4(address);
  const parsedCidr = parseIpv4Cidr(cidr);
  if (ip === null || !parsedCidr) {
    return false;
  }
  const { network, prefix } = parsedCidr;
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return (ip & mask) === (network & mask);
}

function isAllowedClient(address: string | null, allowedCidrs: string[]): boolean {
  if (!address) {
    return true;
  }
  if (isLoopback(address)) {
    return true;
  }
  if (address.startsWith('fd7a:115c:a1e0:')) {
    return true;
  }
  if (allowedCidrs.length === 0) {
    return true;
  }
  return allowedCidrs.some((cidr) => cidrContains(address, cidr));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function servePlexAsset(urlPath: string): Promise<Response | null> {
  const prefix = '/vendor/';
  if (!urlPath.startsWith(prefix)) {
    return null;
  }

  const plexRoot = path.join(process.cwd(), 'node_modules', '@ibm', 'plex');
  const relativePath = urlPath.slice(prefix.length);
  const diskPath = path.resolve(plexRoot, relativePath);

  if (!diskPath.startsWith(`${plexRoot}${path.sep}`)) {
    return new Response('Forbidden', { status: 403 });
  }

  const file = Bun.file(diskPath);
  if (!(await file.exists())) {
    return new Response('Not found', { status: 404 });
  }
  const ext = path.extname(diskPath).toLowerCase();

  const contentType =
    ext === '.css'
      ? 'text/css; charset=utf-8'
      : ext === '.woff2'
        ? 'font/woff2'
        : ext === '.woff'
          ? 'font/woff'
          : 'application/octet-stream';

  return new Response(file, {
    headers: {
      'content-type': contentType,
      'cache-control': 'public, max-age=604800',
    },
  });
}

async function loadFrontendAsset(fileName: 'index.html' | 'styles.css'): Promise<string> {
  const srcPath = path.join(process.cwd(), 'src', 'web', fileName);
  return readFile(srcPath, 'utf8');
}

async function buildFrontendBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(process.cwd(), 'src', 'web', 'main.tsx')],
    target: 'browser',
    format: 'esm',
    minify: false,
    sourcemap: 'inline',
  });

  if (!result.success || result.outputs.length === 0) {
    throw new Error('Failed to build frontend bundle.');
  }

  return await result.outputs[0].text();
}

const isDevLive = process.env.DARKHOLD_DEV === '1';

const eventsTmpRoot = path.join('/tmp', `darkhold-events-${process.pid}`);
const threadEventLog = createThreadEventLogStore(eventsTmpRoot);
const config = parseConfig(process.argv.slice(2));
await setBrowserRoot(config.basePath);
await mkdir(eventsTmpRoot, { recursive: true });
let appServerSessionCounter = 0;
const activeAppServerChildren = new Set<ChildProcess>();
const appServerSessions = new Map<number, AppServerSession>();
const threadToSessionId = new Map<string, number>();
const threadSseSubscribers = new Map<string, Map<number, (frame: string) => void>>();
const threadPublishChains = new Map<string, Promise<void>>();
const threadNextEventId = new Map<string, number>();
const pendingThreadInteractionRequests = new Map<
  string,
  Map<string, { sessionId: number; upstreamRequestId: number; method: string; params: any }>
>();
let threadSseSubscriberCounter = 0;

async function appendThreadEvent(threadId: string, payload: string) {
  await threadEventLog.append(threadId, payload);
}

async function readThreadEvents(threadId: string): Promise<string[]> {
  return await threadEventLog.read(threadId);
}

async function rehydrateThreadEventsFromRead(threadId: string, readResult: any): Promise<void> {
  await threadEventLog.rehydrateFromThreadRead(threadId, readResult);
  const events = await readThreadEvents(threadId);
  threadNextEventId.set(threadId, events.length + 1);
}

function bindThreadToSession(threadId: string, session: AppServerSession) {
  threadToSessionId.set(threadId, session.id);
  session.knownThreadIds.add(threadId);
}

function inferThreadIdForServerRequest(session: AppServerSession, parsed: any): string | null {
  const explicitThreadId = typeof parsed?.params?.threadId === 'string' ? parsed.params.threadId : null;
  if (explicitThreadId) {
    return explicitThreadId;
  }
  const known = [...session.knownThreadIds];
  if (known.length === 1) {
    return known[0] ?? null;
  }
  return null;
}

function sseFrameFromPayload(id: number, payload: string): string {
  const lines = payload.split('\n');
  const data = lines.map((line) => `data: ${line}`).join('\n');
  return `id: ${id}\n${data}\n\n`;
}

async function ensureThreadNextEventId(threadId: string): Promise<number> {
  const known = threadNextEventId.get(threadId);
  if (known !== undefined) {
    return known;
  }
  const events = await readThreadEvents(threadId);
  const next = events.length + 1;
  threadNextEventId.set(threadId, next);
  return next;
}

function publishThreadEvent(threadId: string, payload: string) {
  const prior = threadPublishChains.get(threadId) ?? Promise.resolve();
  const next = prior.then(async () => {
    await appendThreadEvent(threadId, payload);
    const id = await ensureThreadNextEventId(threadId);
    threadNextEventId.set(threadId, id + 1);
    const frame = sseFrameFromPayload(id, payload);
    const subscribers = threadSseSubscribers.get(threadId);
    if (!subscribers) {
      return;
    }
    for (const [subscriberId, sendFrame] of subscribers) {
      try {
        sendFrame(frame);
      } catch {
        subscribers.delete(subscriberId);
      }
    }
    if (subscribers.size === 0) {
      threadSseSubscribers.delete(threadId);
    }
  });
  threadPublishChains.set(
    threadId,
    next.catch(() => {
      // Keep the chain alive for subsequent events after an intermittent failure.
    }),
  );
  return next;
}

function registerPendingThreadInteractionRequest(
  threadId: string,
  requestId: string,
  value: { sessionId: number; upstreamRequestId: number; method: string; params: any },
) {
  let requests = pendingThreadInteractionRequests.get(threadId);
  if (!requests) {
    requests = new Map();
    pendingThreadInteractionRequests.set(threadId, requests);
  }
  requests.set(requestId, value);
}

function resolvePendingThreadInteractionRequest(threadId: string, requestId: string) {
  const requests = pendingThreadInteractionRequests.get(threadId);
  if (!requests) {
    return null;
  }
  const found = requests.get(requestId) ?? null;
  if (!found) {
    return null;
  }
  requests.delete(requestId);
  if (requests.size === 0) {
    pendingThreadInteractionRequests.delete(threadId);
  }
  return found;
}

function spawnAppServerSession(): AppServerSession {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeAppServerChildren.add(child);
  const session: AppServerSession = {
    id: ++appServerSessionCounter,
    child,
    stdoutBuffer: '',
    upstreamInitialized: false,
    knownThreadIds: new Set<string>(),
    nextUpstreamRequestId: 1_000_000,
    pendingClientRequests: new Map(),
  };
  appServerSessions.set(session.id, session);
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[app-server session=${session.id}] ${String(chunk)}`);
  });
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      session.stdoutBuffer += String(chunk);
      while (true) {
        const newlineIndex = session.stdoutBuffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }
        const line = session.stdoutBuffer.slice(0, newlineIndex).trim();
        session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        tapRpcFrame('app-server->client', line);
        let parsed: any = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }

        if (parsed && typeof parsed.id === 'number' && ('result' in parsed || 'error' in parsed)) {
          const route = session.pendingClientRequests.get(parsed.id);
          if (route) {
            session.pendingClientRequests.delete(parsed.id);
            if (route.method === 'thread/start' || route.method === 'thread/read' || route.method === 'thread/resume') {
              const threadId = parsed?.result?.thread?.id;
              if (typeof threadId === 'string') {
                bindThreadToSession(threadId, session);
                if ((route.method === 'thread/read' || route.method === 'thread/resume') && parsed?.result?.thread?.turns) {
                  void rehydrateThreadEventsFromRead(threadId, parsed.result);
                }
              }
            }

            route.resolveHttp?.(parsed);
            continue;
          }
        }

        if (parsed && typeof parsed.id === 'number' && typeof parsed.method === 'string') {
          const inferredThreadId = inferThreadIdForServerRequest(session, parsed);
          if (inferredThreadId) {
            bindThreadToSession(inferredThreadId, session);
            const requestId = String(parsed.id);
            registerPendingThreadInteractionRequest(inferredThreadId, requestId, {
              sessionId: session.id,
              upstreamRequestId: parsed.id,
              method: parsed.method,
              params: parsed.params ?? {},
            });
            void publishThreadEvent(
              inferredThreadId,
              JSON.stringify({
                method: 'darkhold/interaction/request',
                params: {
                  threadId: inferredThreadId,
                  requestId,
                  method: parsed.method,
                  params: parsed.params ?? {},
                },
              }),
            );
          }
          continue;
        }

        if (parsed && typeof parsed.method === 'string') {
          const threadId = parsed?.params?.threadId;
          if (typeof threadId === 'string') {
            bindThreadToSession(threadId, session);
            void publishThreadEvent(threadId, line);
          }
        }
      }
    });
  }
  child.on('exit', (code, signal) => {
    logProxy(`session=${session.id} app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    activeAppServerChildren.delete(child);
    for (const [threadId, requests] of pendingThreadInteractionRequests) {
      for (const [requestId, value] of requests) {
        if (value.sessionId === session.id) {
          requests.delete(requestId);
        }
      }
      if (requests.size === 0) {
        pendingThreadInteractionRequests.delete(threadId);
      }
    }
    for (const route of session.pendingClientRequests.values()) {
      route.rejectHttp?.(new Error('app-server exited'));
    }
    appServerSessions.delete(session.id);
    for (const threadId of session.knownThreadIds) {
      if (threadToSessionId.get(threadId) === session.id) {
        threadToSessionId.delete(threadId);
      }
    }
  });
  return session;
}

function selectSession(threadIdHint: string | null): AppServerSession {
  if (threadIdHint) {
    const mappedSessionId = threadToSessionId.get(threadIdHint) ?? null;
    if (mappedSessionId !== null) {
      const mappedSession = appServerSessions.get(mappedSessionId) ?? null;
      if (mappedSession && mappedSession.child.exitCode === null && !mappedSession.child.killed) {
        return mappedSession;
      }
    }
  }

  for (const session of appServerSessions.values()) {
    if (session.child.exitCode === null && !session.child.killed) {
      return session;
    }
  }

  return spawnAppServerSession();
}

async function requestSessionRpc(session: AppServerSession, method: string, params: unknown): Promise<any> {
  const appServer = session.child;
  const stdin = appServer.stdin;
  if (appServer.exitCode !== null || appServer.killed || !stdin) {
    throw new Error('app-server is unavailable');
  }

  return await new Promise<any>((resolve, reject) => {
    const upstreamId = session.nextUpstreamRequestId;
    session.nextUpstreamRequestId += 1;

    const timeout = setTimeout(() => {
      if (!session.pendingClientRequests.has(upstreamId)) {
        return;
      }
      session.pendingClientRequests.delete(upstreamId);
      reject(new Error(`RPC request timed out: ${method}`));
    }, 20_000);

    session.pendingClientRequests.set(upstreamId, {
      method,
      resolveHttp: (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      },
      rejectHttp: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    const outbound = JSON.stringify({ id: upstreamId, method, params });
    tapRpcFrame('client->app-server', outbound);
    stdin.write(outbound.endsWith('\n') ? outbound : `${outbound}\n`);
  });
}

async function ensureSessionInitialized(session: AppServerSession): Promise<void> {
  if (session.upstreamInitialized) {
    return;
  }
  const response = await requestSessionRpc(session, 'initialize', {
    clientInfo: { name: 'darkhold-http', title: 'Darkhold HTTP', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  if (response?.error) {
    const message = String(response.error?.message ?? '');
    if (!message.toLowerCase().includes('already initialized')) {
      throw new Error(message || 'Failed to initialize app-server session.');
    }
  }
  session.upstreamInitialized = true;
}

async function stopChildGracefully(child: ChildProcess, timeoutMs = 1500): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL');
      }
      resolve();
    }, timeoutMs);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGTERM');
  });
}

const [cachedIndexHtml, cachedStylesCss, cachedAppJs] = isDevLive
  ? [null, null, null]
  : await Promise.all([loadFrontendAsset('index.html'), loadFrontendAsset('styles.css'), buildFrontendBundle()]);

const server = Bun.serve({
  hostname: config.bind,
  port: config.port,
  async fetch(req, server) {
    const clientIp = server.requestIP(req)?.address ?? null;
    if (!isAllowedClient(clientIp, config.allowCidrs)) {
      return json({ error: 'Forbidden for client IP.' }, 403);
    }

    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, basePath: getHomeRoot() });
    }

    if (req.method === 'GET' && url.pathname === '/api/thread/events') {
      const threadId = (url.searchParams.get('threadId') ?? '').trim();
      if (!threadId) {
        return json({ error: 'threadId is required.' }, 400);
      }
      const events = await readThreadEvents(threadId);
      return json({ threadId, events });
    }

    if (req.method === 'GET' && url.pathname === '/api/thread/events/stream') {
      const threadId = (url.searchParams.get('threadId') ?? '').trim();
      if (!threadId) {
        return json({ error: 'threadId is required.' }, 400);
      }
      const headerLastEventId = req.headers.get('last-event-id');
      const queryLastEventId = url.searchParams.get('lastEventId');
      const lastEventIdRaw = (headerLastEventId ?? queryLastEventId ?? '').trim();
      const lastEventIdParsed = Number.parseInt(lastEventIdRaw, 10);
      const startEventId = Number.isFinite(lastEventIdParsed) && lastEventIdParsed >= 0 ? lastEventIdParsed + 1 : 1;
      const history = await readThreadEvents(threadId);
      const nextIdFromHistory = history.length + 1;
      const existingNextId = threadNextEventId.get(threadId);
      if (existingNextId === undefined || existingNextId < nextIdFromHistory) {
        threadNextEventId.set(threadId, nextIdFromHistory);
      }

      const encoder = new TextEncoder();
      const subscriberId = ++threadSseSubscriberCounter;
      let cleanup: (() => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const sendFrame = (frame: string) => {
            controller.enqueue(encoder.encode(frame));
          };

          for (let index = Math.max(0, startEventId - 1); index < history.length; index += 1) {
            const frame = sseFrameFromPayload(index + 1, history[index] ?? '');
            sendFrame(frame);
          }

          let subscribers = threadSseSubscribers.get(threadId);
          if (!subscribers) {
            subscribers = new Map();
            threadSseSubscribers.set(threadId, subscribers);
          }
          subscribers.set(subscriberId, sendFrame);

          const keepAlive = setInterval(() => {
            sendFrame(': keepalive\n\n');
          }, 15_000);

          cleanup = () => {
            clearInterval(keepAlive);
            const currentSubscribers = threadSseSubscribers.get(threadId);
            if (currentSubscribers) {
              currentSubscribers.delete(subscriberId);
              if (currentSubscribers.size === 0) {
                threadSseSubscribers.delete(threadId);
              }
            }
          };

          req.signal.addEventListener(
            'abort',
            () => {
              cleanup?.();
            },
            { once: true },
          );
        },
        cancel() {
          cleanup?.();
        },
      });

      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      let body: any = null;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON body.' }, 400);
      }

      const method = typeof body?.method === 'string' ? body.method : '';
      if (!method) {
        return json({ error: 'method is required.' }, 400);
      }
      const params = body?.params;
      const threadIdHint = typeof params?.threadId === 'string' ? params.threadId : null;

      try {
        const session = selectSession(threadIdHint);
        if (threadIdHint) {
          bindThreadToSession(threadIdHint, session);
        }
        if (method !== 'initialize') {
          await ensureSessionInitialized(session);
        }
        const response = await requestSessionRpc(session, method, params);
        if (response?.error) {
          return json({ error: String(response.error?.message ?? 'RPC error') }, 400);
        }
        return json(response?.result ?? null);
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/thread/interaction/respond') {
      let body: any = null;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON body.' }, 400);
      }

      const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : '';
      const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
      if (!threadId || !requestId) {
        return json({ error: 'threadId and requestId are required.' }, 400);
      }

      const resolved = resolvePendingThreadInteractionRequest(threadId, requestId);
      if (!resolved) {
        return json({ error: 'interaction request not found or already resolved.' }, 409);
      }

      const session = appServerSessions.get(resolved.sessionId) ?? null;
      if (!session || !session.child.stdin || session.child.exitCode !== null || session.child.killed) {
        return json({ error: 'app-server session is unavailable.' }, 410);
      }

      const outbound =
        body?.error !== undefined
          ? JSON.stringify({ id: resolved.upstreamRequestId, error: body.error })
          : JSON.stringify({ id: resolved.upstreamRequestId, result: body?.result ?? {} });
      tapRpcFrame('client->app-server', outbound);
      session.child.stdin.write(outbound.endsWith('\n') ? outbound : `${outbound}\n`);

      void publishThreadEvent(
        threadId,
        JSON.stringify({
          method: 'darkhold/interaction/resolved',
          params: { threadId, requestId, source: 'http' },
        }),
      );

      return json({ ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/fs/list') {
      try {
        const requestedPath = url.searchParams.get('path') ?? undefined;
        const listing = await listFolder(requestedPath);
        return json(listing);
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (req.method === 'GET' && url.pathname === '/styles.css') {
      const stylesCss = isDevLive ? await loadFrontendAsset('styles.css') : cachedStylesCss;
      return new Response(stylesCss, {
        headers: { 'content-type': 'text/css; charset=utf-8' },
      });
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
      const appJs = isDevLive ? await buildFrontendBundle() : cachedAppJs;
      return new Response(appJs, {
        headers: { 'content-type': 'text/javascript; charset=utf-8' },
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const response = await servePlexAsset(url.pathname);
      if (response) {
        return response;
      }
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const indexHtml = isDevLive ? await loadFrontendAsset('index.html') : cachedIndexHtml;
      return new Response(indexHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
});

const allowListNote =
  config.allowCidrs.length > 0 ? ` (allowed CIDRs: ${config.allowCidrs.join(', ')}, plus localhost)` : '';
console.log(
  `darkhold listening on http://${config.bind}:${server.port}${allowListNote} (base path: ${getHomeRoot()}, app-server transport: stdio per session)`,
);

let shutdownStarted = false;

async function stopAppServerGracefully(timeoutMs = 2500): Promise<void> {
  await Promise.allSettled([...activeAppServerChildren].map((child) => stopChildGracefully(child, timeoutMs)));
}

async function shutdown(signal: NodeJS.Signals) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  console.log(`received ${signal}, shutting down...`);

  server.stop(true);
  await stopAppServerGracefully();
  await rm(eventsTmpRoot, { recursive: true, force: true });
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('uncaughtException', (error) => {
  console.error('uncaught exception, shutting down:', error);
  void shutdown('SIGTERM');
});
process.once('unhandledRejection', (reason) => {
  console.error('unhandled rejection, shutting down:', reason);
  void shutdown('SIGTERM');
});
process.once('exit', () => {
  for (const child of activeAppServerChildren) {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  }
  void rm(eventsTmpRoot, { recursive: true, force: true });
});
