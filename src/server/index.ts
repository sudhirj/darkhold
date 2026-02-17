import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentManager } from '../agent/agent-manager';
import { getHomeRoot, listFolder } from '../fs/home-browser';

type ServerConfig = {
  bind: string;
  port: number;
};

const manager = new AgentManager();

function parseConfig(argv: string[]): ServerConfig {
  let bind = '127.0.0.1';
  let port = 3000;

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
    }
  }

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error('Port must be a number between 1 and 65535.');
  }

  return { bind, port };
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
const [indexHtml, stylesCss, appJs] = await Promise.all([
  loadFrontendAsset('index.html'),
  loadFrontendAsset('styles.css'),
  buildFrontendBundle(),
]);

const server = Bun.serve({
  hostname: config.bind,
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, home: getHomeRoot() });
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
      return new Response(stylesCss, {
        headers: { 'content-type': 'text/css; charset=utf-8' },
      });
    }

    if (req.method === 'GET' && url.pathname === '/app.js') {
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
      return new Response(indexHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`darkhold listening on http://${config.bind}:${server.port}`);
