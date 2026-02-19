import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ChildProcess, spawn } from 'node:child_process';
import { getHomeRoot, listFolder, setBrowserRoot } from '../fs/home-browser';

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
  appServer: ChildProcess | null;
  stdoutBuffer: string;
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

const config = parseConfig(process.argv.slice(2));
await setBrowserRoot(config.basePath);
let wsProxyConnectionCounter = 0;
const activeAppServerChildren = new Set<ChildProcess>();

function spawnAppServerForConnection(connectionId: number): ChildProcess {
  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeAppServerChildren.add(child);
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[app-server conn=${connectionId}] ${String(chunk)}`);
  });
  child.on('exit', () => {
    activeAppServerChildren.delete(child);
  });
  return child;
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
      const upgraded = server.upgrade(req, {
        data: {
          connectionId: 0,
          clientMessageCount: 0,
          appServerMessageCount: 0,
          appServer: null,
          stdoutBuffer: '',
        },
      });
      if (upgraded) {
        return;
      }
      return json({ error: 'WebSocket upgrade failed.' }, 400);
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
      ws.data.stdoutBuffer = '';

      logProxy(`conn=${connectionId} client websocket opened`);
      const appServer = spawnAppServerForConnection(connectionId);
      ws.data.appServer = appServer;

      if (!appServer.stdout) {
        logProxy(`conn=${connectionId} app-server stdout unavailable`);
        ws.close(1011, 'app-server stdout unavailable');
        return;
      }

      appServer.stdout.on('data', (chunk) => {
        ws.data.stdoutBuffer += String(chunk);
        while (true) {
          const newlineIndex = ws.data.stdoutBuffer.indexOf('\n');
          if (newlineIndex < 0) {
            break;
          }
          const line = ws.data.stdoutBuffer.slice(0, newlineIndex).trim();
          ws.data.stdoutBuffer = ws.data.stdoutBuffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }
          ws.data.appServerMessageCount += 1;
          tapRpcFrame('app-server->client', line);
          if (ws.readyState === 1) {
            ws.send(line);
          }
        }
      });

      appServer.on('exit', (code, signal) => {
        logProxy(`conn=${connectionId} app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        ws.data.appServer = null;
        if (ws.readyState === 1) {
          ws.close(1011, 'app-server exited');
        }
      });
    },
    message(ws, message) {
      const connectionId = ws.data.connectionId;
      const appServer = ws.data.appServer;
      if (!appServer || appServer.exitCode !== null || appServer.killed || !appServer.stdin) {
        logProxy(`conn=${connectionId} dropping client message because app-server is unavailable`);
        return;
      }
      ws.data.clientMessageCount += 1;
      const payload = normalizeRpcPayload(message as any);
      tapRpcFrame('client->app-server', payload);
      appServer.stdin.write(payload.endsWith('\n') ? payload : `${payload}\n`);
    },
    close(ws) {
      const connectionId = ws.data.connectionId;
      logProxy(
        `conn=${connectionId} client websocket closed stats(client->app-server=${ws.data.clientMessageCount}, app-server->client=${ws.data.appServerMessageCount})`,
      );
      const appServer = ws.data.appServer;
      ws.data.appServer = null;
      if (appServer) {
        void stopChildGracefully(appServer);
      }
      ws.data.stdoutBuffer = '';
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
});
