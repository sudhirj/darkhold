# Darkhold

Darkhold runs Codex agents on a host machine and exposes them over HTTP with a React UI for folder navigation, thread input, and progress events.

Architecture details: `docs/architecture.md`.

The repository currently contains:
- Go server in `cmd/` + `internal/`
- Web client in `clients/web` (Vite build embedded by Go server)

## Prerequisites

- Go 1.22+
- Node.js 20+ (for `clients/web` Vite build/dev)
- Codex CLI login already completed on the host machine

## Install

```bash
npm --prefix clients/web install
```

## Run in Development

Run single-process Go hot reload with embedded web rebuild on each change:

```bash
go install github.com/air-verse/air@latest
./dev-hot
```

Open: `http://127.0.0.1:3275`

## Network Flags

Darkhold server startup accepts:

- `--bind`: Network interface to bind the HTTP server to.
  Example: `127.0.0.1` (localhost only), `0.0.0.0` (all IPv4 interfaces).
- `--port`: TCP port to listen on.
  Default is `3275`.
- `--allow-cidr`: Allowlist of remote IPv4 CIDRs.
  You can pass this flag multiple times. Loopback (`127.0.0.1` / `::1`) is always allowed.

Default behavior:

- Go server binds to `0.0.0.0:3275` in provided dev scripts.
- Dev scripts set `--allow-cidr 100.64.0.0/10` by default (plus localhost and Tailscale ULA IPv6).

## Build

Build frontend assets for Go embed:

```bash
npm --prefix clients/web run build
```

Run the Go server (builds web client first, then builds and runs Go binary):

```bash
./dev-go-server
```

Run single-process Go hot reload with embedded web rebuild on each change:

```bash
go install github.com/air-verse/air@latest
./dev-hot
```

## API Notes

- Server has no built-in auth (intended for localhost or trusted private network access such as Tailscale).
- Folder browsing is restricted to the user home directory.
- Codex session/turn lifecycle is handled over JSON-RPC using HTTP endpoints on Darkhold; Darkhold talks to `codex app-server` over stdio.

## Useful Endpoints

- `GET /api/health`
- `GET /api/fs/list?path=/optional/path`
- `POST /api/rpc`
- `GET /api/thread/events?threadId=<thread-id>`
- `GET /api/thread/events/stream?threadId=<thread-id>` (SSE)
