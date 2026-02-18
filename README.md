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

Start on localhost port `3275` (D=3, A=2, R=7, K=5):

```bash
bun run dev
```

Run on a custom interface/port:

```bash
bun run start -- --bind 127.0.0.1 --port 3275
```

Open: `http://127.0.0.1:3275`

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

## Useful Endpoints

- `GET /api/health`
- `GET /api/fs/list?path=/optional/path`
- `POST /api/agents/start`
- `GET /api/agents/:id`
- `POST /api/agents/:id/input`
