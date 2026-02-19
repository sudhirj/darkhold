# Darkhold

Darkhold runs Codex agents on a host machine and exposes them over HTTP with a React UI for folder navigation, thread input, and progress events.

## Prerequisites

- Bun 1.2+
- Codex CLI login already completed on the host machine

## Install

```bash
bun install
```

## Install From GitHub Releases

Install the latest release binary directly:

```bash
curl -fsSL https://raw.githubusercontent.com/sudhirj/darkhold/main/install.sh | sh
```

Install a specific release tag:

```bash
curl -fsSL https://raw.githubusercontent.com/sudhirj/darkhold/main/install.sh | sh -s -- --version build-<git-sha>
```

## Run in Development

Start on port `3275` (D=3, A=2, R=7, K=5):

```bash
bun run dev
```

Run on a custom interface/port:

```bash
bun run start -- --bind 127.0.0.1 --port 3275
```

Open: `http://127.0.0.1:3275`

## Network Flags

Darkhold server startup accepts:

- `--bind`: Network interface to bind the HTTP server to.
  Example: `127.0.0.1` (localhost only), `0.0.0.0` (all IPv4 interfaces).
- `--port`: TCP port to listen on.
  Default is `3275`.
- `--rpc-port`: TCP port for the Codex app-server WebSocket endpoint.
  Default is `3276`.
- `--allow-cidr`: Allowlist of remote IPv4 CIDRs.
  You can pass this flag multiple times. Loopback (`127.0.0.1` / `::1`) is always allowed.

Default behavior:

- `bun run start` defaults to `--bind 127.0.0.1 --port 3275` with no CIDR restriction flag.
- `bun run dev` defaults to `--bind 0.0.0.0 --port 3275 --allow-cidr 100.64.0.0/10`.
- `100.64.0.0/10` is the default Tailscale CGNAT range used by the dev script.

## Build

Build server + frontend assets:

```bash
bun run build
```

Compile a single distributable binary:

```bash
bun run bundle
```

Output binary path:

- `dist/darkhold`

## API Notes

- Server has no built-in auth (intended for localhost or trusted private network access such as Tailscale).
- Folder browsing is restricted to the user home directory.
- Codex session/turn lifecycle is handled over JSON-RPC WebSockets via `codex app-server`, proxied through the Darkhold server.

## Useful Endpoints

- `GET /api/health`
- `GET /api/fs/list?path=/optional/path`
- `GET /api/rpc/ws` (WebSocket upgrade endpoint for app-server RPC proxy)
