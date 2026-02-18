import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentManager } from '../agent/agent-manager';
import { getHomeRoot, listFolder, setBrowserRoot } from '../fs/home-browser';

type ServerConfig = {
  bind: string;
  port: number;
  allowCidrs: string[];
  basePath?: string;
};

const manager = new AgentManager();

function parseConfig(argv: string[]): ServerConfig {
  let bind = '127.0.0.1';
  let port = 3275;
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

  for (const cidr of allowCidrs) {
    if (!parseIpv4Cidr(cidr)) {
      throw new Error(`Invalid CIDR: ${cidr}. Expected IPv4 CIDR such as 100.64.0.0/10.`);
    }
  }

  return { bind, port, allowCidrs, basePath };
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
    return allowedCidrs.length === 0;
  }
  if (isLoopback(address)) {
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

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function getSessionIdFromPath(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'agents') {
    return parts[2] ?? null;
  }
  return null;
}

const config = parseConfig(process.argv.slice(2));
await setBrowserRoot(config.basePath);
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

    if (req.method === 'GET' && url.pathname === '/api/fs/list') {
      try {
        const requestedPath = url.searchParams.get('path') ?? undefined;
        const listing = await listFolder(requestedPath);
        return json(listing);
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/agents/start') {
      const body = await readBody(req);
      if (!body?.path || typeof body.path !== 'string') {
        return json({ error: 'Body must include a folder path.' }, 400);
      }
      try {
        const listing = await listFolder(body.path);
        const session = manager.startSession(listing.path);
        return json({ session }, 201);
      } catch (error: unknown) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/agents') {
      return json({ sessions: manager.listSessions() });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/agents/')) {
      const sessionId = getSessionIdFromPath(url);
      if (!sessionId) {
        return json({ error: 'Invalid session path.' }, 404);
      }

      if (url.pathname.endsWith('/events')) {
        const sinceRaw = url.searchParams.get('since') ?? '0';
        const since = Number.parseInt(sinceRaw, 10);
        const events = manager.getEventsSince(sessionId, Number.isFinite(since) ? since : 0);
        if (!events) {
          return json({ error: 'Session not found.' }, 404);
        }
        return json({ events });
      }

      const session = manager.getSession(sessionId);
      if (!session) {
        return json({ error: 'Session not found.' }, 404);
      }
      return json({ session });
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/agents/')) {
      const sessionId = getSessionIdFromPath(url);
      if (!sessionId || !url.pathname.endsWith('/input')) {
        return json({ error: 'Invalid input path.' }, 404);
      }

      const body = await readBody(req);
      if (!body?.input || typeof body.input !== 'string') {
        return json({ error: 'Body must include input text.' }, 400);
      }

      try {
        manager.submitInput(sessionId, body.input);
        return json({ accepted: true }, 202);
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
console.log(`darkhold listening on http://${config.bind}:${server.port}${allowListNote} (base path: ${getHomeRoot()})`);
