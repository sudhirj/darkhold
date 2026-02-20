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

type WsProxyData = {
  connectionId: number;
  clientMessageCount: number;
  appServerMessageCount: number;
  appServerId: number | null;
  desiredThreadId: string | null;
};

type AppServerSession = {
  id: number;
  child: ChildProcess;
  stdoutBuffer: string;
  turnInProgress: boolean;
  shutdownAfterTurnComplete: boolean;
  attachedConnectionIds: Set<number>;
  knownThreadIds: Set<string>;
  nextUpstreamRequestId: number;
  pendingClientRequests: Map<number, { connectionId: number; clientRequestId: number; method: string }>;
  pendingServerRequestTargets: Map<number, number>;
  lastRequesterConnectionId: number | null;
};

type ServerWebSocketLike = {
  readyState: number;
  data: WsProxyData;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
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
let wsProxyConnectionCounter = 0;
let appServerSessionCounter = 0;
const activeWsConnections = new Map<number, ServerWebSocketLike>();
const activeAppServerChildren = new Set<ChildProcess>();
const appServerSessions = new Map<number, AppServerSession>();
const reusableAppServerSessionIds: number[] = [];
const threadToSessionId = new Map<string, number>();
const threadToConnectionIds = new Map<string, Set<number>>();
const connectionToThreadIds = new Map<number, Set<string>>();

function sessionForConnection(ws: ServerWebSocketLike): AppServerSession | null {
  if (ws.data.appServerId === null) {
    return null;
  }
  return appServerSessions.get(ws.data.appServerId) ?? null;
}

async function appendThreadEvent(threadId: string, payload: string) {
  await threadEventLog.append(threadId, payload);
}

async function readThreadEvents(threadId: string): Promise<string[]> {
  return await threadEventLog.read(threadId);
}

async function rehydrateThreadEventsFromRead(threadId: string, readResult: any): Promise<void> {
  await threadEventLog.rehydrateFromThreadRead(threadId, readResult);
}

function bindThreadToSession(threadId: string, session: AppServerSession) {
  threadToSessionId.set(threadId, session.id);
  session.knownThreadIds.add(threadId);
}

function bindConnectionToThread(connectionId: number, threadId: string) {
  let connectionsForThread = threadToConnectionIds.get(threadId);
  if (!connectionsForThread) {
    connectionsForThread = new Set<number>();
    threadToConnectionIds.set(threadId, connectionsForThread);
  }
  connectionsForThread.add(connectionId);

  let threadsForConnection = connectionToThreadIds.get(connectionId);
  if (!threadsForConnection) {
    threadsForConnection = new Set<string>();
    connectionToThreadIds.set(connectionId, threadsForConnection);
  }
  threadsForConnection.add(threadId);
}

function unbindConnectionFromAllThreads(connectionId: number) {
  const threadsForConnection = connectionToThreadIds.get(connectionId);
  if (!threadsForConnection) {
    return;
  }
  for (const threadId of threadsForConnection) {
    const connectionsForThread = threadToConnectionIds.get(threadId);
    if (!connectionsForThread) {
      continue;
    }
    connectionsForThread.delete(connectionId);
    if (connectionsForThread.size === 0) {
      threadToConnectionIds.delete(threadId);
    }
  }
  connectionToThreadIds.delete(connectionId);
}

function sendToConnection(connectionId: number, payload: string, direction: 'app-server->client' | 'client->app-server' = 'app-server->client') {
  const ws = activeWsConnections.get(connectionId);
  if (!ws || ws.readyState !== 1) {
    return false;
  }
  if (direction === 'app-server->client') {
    ws.data.appServerMessageCount += 1;
  } else {
    ws.data.clientMessageCount += 1;
  }
  ws.send(payload);
  return true;
}

function sendToThreadConnections(threadId: string, payload: string): boolean {
  const connectionsForThread = threadToConnectionIds.get(threadId);
  if (!connectionsForThread || connectionsForThread.size === 0) {
    return false;
  }

  let deliveredAny = false;
  for (const connectionId of Array.from(connectionsForThread)) {
    const delivered = sendToConnection(connectionId, payload);
    if (!delivered) {
      connectionsForThread.delete(connectionId);
      const threadsForConnection = connectionToThreadIds.get(connectionId);
      if (threadsForConnection) {
        threadsForConnection.delete(threadId);
        if (threadsForConnection.size === 0) {
          connectionToThreadIds.delete(connectionId);
        }
      }
      continue;
    }
    deliveredAny = true;
  }

  if (connectionsForThread.size === 0) {
    threadToConnectionIds.delete(threadId);
  }
  return deliveredAny;
}

function spawnAppServerSession(connectionId: number): AppServerSession {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeAppServerChildren.add(child);
  const session: AppServerSession = {
    id: ++appServerSessionCounter,
    child,
    stdoutBuffer: '',
    turnInProgress: false,
    shutdownAfterTurnComplete: false,
    attachedConnectionIds: new Set<number>(),
    knownThreadIds: new Set<string>(),
    nextUpstreamRequestId: 1_000_000,
    pendingClientRequests: new Map(),
    pendingServerRequestTargets: new Map(),
    lastRequesterConnectionId: null,
  };
  appServerSessions.set(session.id, session);
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[app-server session=${session.id} conn=${connectionId}] ${String(chunk)}`);
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
            const outbound = { ...parsed, id: route.clientRequestId };

            if (route.method === 'thread/start' || route.method === 'thread/read' || route.method === 'thread/resume') {
              const threadId = parsed?.result?.thread?.id;
              if (typeof threadId === 'string') {
                bindThreadToSession(threadId, session);
                bindConnectionToThread(route.connectionId, threadId);
                if ((route.method === 'thread/read' || route.method === 'thread/resume') && parsed?.result?.thread?.turns) {
                  void rehydrateThreadEventsFromRead(threadId, parsed.result);
                }
              }
            }

            void sendToConnection(route.connectionId, JSON.stringify(outbound));
            continue;
          }
          if (session.pendingServerRequestTargets.has(parsed.id)) {
            continue;
          }
        }

        if (parsed && typeof parsed.id === 'number' && typeof parsed.method === 'string') {
          const preferred = session.lastRequesterConnectionId;
          const targetConnectionId =
            (preferred !== null && session.attachedConnectionIds.has(preferred) ? preferred : [...session.attachedConnectionIds][0]) ?? null;
          if (targetConnectionId !== null) {
            session.pendingServerRequestTargets.set(parsed.id, targetConnectionId);
            void sendToConnection(targetConnectionId, line);
          }
          continue;
        }

        if (parsed && typeof parsed.method === 'string') {
          const threadId = parsed?.params?.threadId;
          let deliveredViaThreadSubscription = false;
          if (typeof threadId === 'string') {
            bindThreadToSession(threadId, session);
            void appendThreadEvent(threadId, line);
            deliveredViaThreadSubscription = sendToThreadConnections(threadId, line);
          }
          if (parsed.method === 'turn/started') {
            session.turnInProgress = true;
          }
          if (parsed.method === 'turn/completed') {
            session.turnInProgress = false;
            if (session.shutdownAfterTurnComplete && session.attachedConnectionIds.size === 0) {
              logProxy(`session=${session.id} turn completed while detached, shutting down app-server`);
              void stopChildGracefully(session.child);
            }
          }

          if (deliveredViaThreadSubscription) {
            continue;
          }
        }

        for (const attachedConnectionId of session.attachedConnectionIds) {
          const delivered = sendToConnection(attachedConnectionId, line);
          if (!delivered) {
            session.attachedConnectionIds.delete(attachedConnectionId);
          }
        }
      }
    });
  }
  child.on('exit', (code, signal) => {
    logProxy(`session=${session.id} app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    activeAppServerChildren.delete(child);
    appServerSessions.delete(session.id);
    const reusableIndex = reusableAppServerSessionIds.indexOf(session.id);
    if (reusableIndex >= 0) {
      reusableAppServerSessionIds.splice(reusableIndex, 1);
    }
    for (const threadId of session.knownThreadIds) {
      if (threadToSessionId.get(threadId) === session.id) {
        threadToSessionId.delete(threadId);
      }
    }
    for (const connectionId of session.attachedConnectionIds) {
      const attachedWs = activeWsConnections.get(connectionId);
      if (attachedWs && attachedWs.readyState === 1) {
        attachedWs.close(1011, 'app-server exited');
      }
    }
  });
  return session;
}

function attachSessionToConnection(session: AppServerSession, ws: ServerWebSocketLike) {
  session.attachedConnectionIds.add(ws.data.connectionId);
  session.shutdownAfterTurnComplete = false;
  ws.data.appServerId = session.id;
  const reusableIndex = reusableAppServerSessionIds.indexOf(session.id);
  if (reusableIndex >= 0) {
    reusableAppServerSessionIds.splice(reusableIndex, 1);
  }
}

function takeReusableSession(): AppServerSession | null {
  while (reusableAppServerSessionIds.length > 0) {
    const sessionId = reusableAppServerSessionIds.shift();
    if (sessionId === undefined) {
      return null;
    }
    const session = appServerSessions.get(sessionId);
    if (!session) {
      continue;
    }
    if (session.child.exitCode !== null || session.child.killed) {
      continue;
    }
    if (session.attachedConnectionIds.size > 0) {
      continue;
    }
    return session;
  }
  return null;
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

const server = Bun.serve<WsProxyData>({
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

    if (req.method === 'GET' && url.pathname === '/api/rpc/ws') {
      const desiredThreadIdRaw = url.searchParams.get('threadId');
      const desiredThreadId = desiredThreadIdRaw && desiredThreadIdRaw.trim().length > 0 ? desiredThreadIdRaw.trim() : null;
      const upgraded = server.upgrade(req, {
        data: {
          connectionId: 0,
          clientMessageCount: 0,
          appServerMessageCount: 0,
          appServerId: null,
          desiredThreadId,
        },
      });
      if (upgraded) {
        return;
      }
      return json({ error: 'WebSocket upgrade failed.' }, 400);
    }

    if (req.method === 'GET' && url.pathname === '/api/thread/events') {
      const threadId = (url.searchParams.get('threadId') ?? '').trim();
      if (!threadId) {
        return json({ error: 'threadId is required.' }, 400);
      }
      const events = await readThreadEvents(threadId);
      return json({ threadId, events });
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
  websocket: {
    open(ws) {
      const connectionId = ++wsProxyConnectionCounter;
      ws.data.connectionId = connectionId;
      ws.data.clientMessageCount = 0;
      ws.data.appServerMessageCount = 0;
      ws.data.appServerId = null;
      activeWsConnections.set(connectionId, ws);

      logProxy(`conn=${connectionId} client websocket opened`);
      if (ws.data.desiredThreadId) {
        bindConnectionToThread(connectionId, ws.data.desiredThreadId);
        const mappedSessionId = threadToSessionId.get(ws.data.desiredThreadId) ?? null;
        if (mappedSessionId !== null) {
          const mappedSession = appServerSessions.get(mappedSessionId) ?? null;
          if (mappedSession && mappedSession.child.exitCode === null && !mappedSession.child.killed) {
            attachSessionToConnection(mappedSession, ws);
            logProxy(`conn=${connectionId} attached to mapped session=${mappedSession.id} for thread=${ws.data.desiredThreadId}`);
          }
        }
      }
    },
    message(ws, message) {
      const connectionId = ws.data.connectionId;
      const payload = normalizeRpcPayload(message as any);
      let parsed: any = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }

      if (parsed && typeof parsed.id === 'number' && parsed.method === 'darkhold/thread/events') {
        const threadId = typeof parsed?.params?.threadId === 'string' ? parsed.params.threadId : '';
        void (async () => {
          const events = threadId ? await readThreadEvents(threadId) : [];
          const response = {
            id: parsed.id,
            result: {
              threadId,
              events,
            },
          };
          void sendToConnection(connectionId, JSON.stringify(response));
        })();
        return;
      }

      const threadIdHint = typeof parsed?.params?.threadId === 'string' ? parsed.params.threadId : null;
      if (threadIdHint) {
        bindConnectionToThread(connectionId, threadIdHint);
      }
      let session = sessionForConnection(ws);
      if (threadIdHint) {
        const mappedSessionId = threadToSessionId.get(threadIdHint) ?? null;
        if (mappedSessionId !== null) {
          const mappedSession = appServerSessions.get(mappedSessionId) ?? null;
          if (mappedSession && mappedSession.child.exitCode === null && !mappedSession.child.killed) {
            if (!session || session.id !== mappedSession.id) {
              if (session) {
                session.attachedConnectionIds.delete(connectionId);
              }
              attachSessionToConnection(mappedSession, ws);
              session = mappedSession;
            }
          }
        }
      }

      if (!session) {
        const reusableSession = takeReusableSession();
        if (reusableSession) {
          attachSessionToConnection(reusableSession, ws);
          session = reusableSession;
        } else {
          const spawned = spawnAppServerSession(connectionId);
          attachSessionToConnection(spawned, ws);
          session = spawned;
        }
      }

      const appServer = session.child;
      if (appServer.exitCode !== null || appServer.killed || !appServer.stdin) {
        logProxy(`conn=${connectionId} dropping client message because app-server is unavailable`);
        return;
      }

      if (parsed && typeof parsed.id === 'number' && typeof parsed.method !== 'string') {
        const target = session.pendingServerRequestTargets.get(parsed.id);
        if (target === connectionId) {
          session.pendingServerRequestTargets.delete(parsed.id);
          ws.data.clientMessageCount += 1;
          tapRpcFrame('client->app-server', payload);
          appServer.stdin.write(payload.endsWith('\n') ? payload : `${payload}\n`);
        }
        return;
      }

      if (parsed && typeof parsed.id === 'number' && typeof parsed.method === 'string') {
        const upstreamId = session.nextUpstreamRequestId;
        session.nextUpstreamRequestId += 1;
        session.pendingClientRequests.set(upstreamId, {
          connectionId,
          clientRequestId: parsed.id,
          method: parsed.method,
        });

        if (parsed.method === 'turn/start') {
          session.turnInProgress = true;
        }
        if (threadIdHint) {
          bindThreadToSession(threadIdHint, session);
        }

        const outbound = JSON.stringify({ ...parsed, id: upstreamId });
        session.lastRequesterConnectionId = connectionId;
        ws.data.clientMessageCount += 1;
        tapRpcFrame('client->app-server', outbound);
        appServer.stdin.write(outbound.endsWith('\n') ? outbound : `${outbound}\n`);
        return;
      }

      if (threadIdHint) {
        bindThreadToSession(threadIdHint, session);
      }
      session.lastRequesterConnectionId = connectionId;
      ws.data.clientMessageCount += 1;
      tapRpcFrame('client->app-server', payload);
      appServer.stdin.write(payload.endsWith('\n') ? payload : `${payload}\n`);
    },
    close(ws) {
      const connectionId = ws.data.connectionId;
      logProxy(
        `conn=${connectionId} client websocket closed stats(client->app-server=${ws.data.clientMessageCount}, app-server->client=${ws.data.appServerMessageCount})`,
      );
      activeWsConnections.delete(connectionId);
      unbindConnectionFromAllThreads(connectionId);
      const session = sessionForConnection(ws);
      if (session) {
        session.attachedConnectionIds.delete(connectionId);
        for (const [requestId, targetConnectionId] of session.pendingServerRequestTargets) {
          if (targetConnectionId === connectionId) {
            session.pendingServerRequestTargets.delete(requestId);
          }
        }
        for (const [requestId, route] of session.pendingClientRequests) {
          if (route.connectionId === connectionId) {
            session.pendingClientRequests.delete(requestId);
          }
        }
      }
      if (session && session.attachedConnectionIds.size === 0) {
        if (session.turnInProgress) {
          session.shutdownAfterTurnComplete = true;
          if (!reusableAppServerSessionIds.includes(session.id)) {
            reusableAppServerSessionIds.push(session.id);
          }
          logProxy(`conn=${connectionId} detached from session=${session.id}; waiting for turn/completed`);
        } else {
          void stopChildGracefully(session.child);
        }
      }
      ws.data.appServerId = null;
    },
  },
});

const allowListNote =
  config.allowCidrs.length > 0 ? ` (allowed CIDRs: ${config.allowCidrs.join(', ')}, plus localhost)` : '';
console.log(
  `darkhold listening on http://${config.bind}:${server.port}${allowListNote} (base path: ${getHomeRoot()}, app-server transport: stdio per websocket)`,
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
