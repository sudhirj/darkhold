# Architecture

## Overview
Darkhold has two runtime parts:
- A Go server at repository root (`cmd/`, `internal/`) that owns Codex session orchestration, HTTP APIs, SSE fanout, and static hosting.
- A React web client in `clients/web` that renders thread state and communicates with the server over HTTP + SSE.

The server is the only component that talks to `codex app-server`, and it does so via stdio.

## Server Architecture (Go Root)

### Process Entry and Lifecycle
- `cmd/darkhold/main.go`
- Responsibilities:
  - Parse CLI/network config.
  - Set filesystem browser root.
  - Create append-only thread event store.
  - Construct HTTP server using `internal/server`.
  - Handle graceful shutdown (HTTP, child sessions, event store cleanup).

### Configuration Layer
- `internal/config/config.go`
- Responsibilities:
  - Parse flags (`--bind`, `--port`, `--allow-cidr`, `--base-path`).
  - Validate ranges and CIDR syntax.
  - Gate remote client access with `IsAllowedClient`.

### Filesystem Safety Layer
- `internal/fs/home_browser.go`
- Responsibilities:
  - Constrain browsing to configured root.
  - Normalize and validate user-supplied paths.
  - Return folder listing DTOs for the web client.

### Event Store Layer
- `internal/events/store.go`
- Responsibilities:
  - Persist per-thread events as append-only logs.
  - Rehydrate event logs from `thread/read` payloads.
  - Provide read APIs for replay and resume.

### HTTP and Session Orchestration Layer
- `internal/server/server.go`
- Responsibilities:
  - Route APIs:
    - `GET /api/health`
    - `GET /api/fs/list`
    - `POST /api/rpc`
    - `GET /api/thread/events`
    - `GET /api/thread/events/stream` (SSE)
    - `POST /api/thread/interaction/respond`
  - Serve embedded web assets from `internal/server/webdist`.
  - Maintain `threadId -> session` affinity to avoid cross-thread session drift.
  - Spawn and manage `codex app-server` child processes over stdio.
  - Convert upstream notifications into stored events and SSE broadcast frames.
  - Accept interaction responses over HTTP and forward them back upstream.

### Server Runtime Model
- Session model:
  - Multiple app-server sessions can exist.
  - Each session tracks known threads and pending RPC responses.
  - Idle reaper policy: any session with no activity for 5 minutes is terminated.
  - Reaper does not kill sessions with active turns; only inactive sessions are eligible.
- Thread model:
  - Each thread maps to one session once discovered.
  - Events are appended to thread log before broadcast.
- Streaming model:
  - SSE subscribers are tracked per thread.
  - New events are fanned out to all subscribers for that thread.
  - Resume uses `Last-Event-ID` + stored history replay.

### Server Component Interaction Flow
1. Client sends `POST /api/rpc` (for example `thread/start`, `turn/start`, `thread/read`).
2. Server selects or spawns a session, ensures upstream initialize, then forwards JSON-RPC over stdio.
3. Upstream notifications are ingested, normalized, appended to thread event log, then broadcast via SSE.
4. Clients reconnect with `Last-Event-ID`; server replays missed events and resumes live stream.
5. For approvals/user-input, server emits a thread interaction request event and waits for `POST /api/thread/interaction/respond`.
6. If a session stays inactive for 5 minutes, the server reaper sends interrupt and the session is cleaned up.

## Web Client Architecture (`clients/web`)

### App Entry and State Coordinator
- `clients/web/src/main.tsx`
- Responsibilities:
  - Own high-level app state (active thread/session, events, prompt input, pending interactions).
  - Call server HTTP APIs and manage EventSource lifecycle.
  - Perform rehydration and stream resume logic.
  - Render dialogs and thread panel components.

### API Access Helper
- `clients/web/src/api.ts`
- Responsibilities:
  - Provide typed JSON fetch wrapper.
  - Normalize server error handling for UI code.

### Event Classification Utilities
- `clients/web/src/session-utils.ts`
- Responsibilities:
  - Classify transient vs conversation events.
  - Derive role and render behavior from server event payloads.

### Transient Event Policy
- Source of truth:
  - `clients/web/src/session-utils.ts:isTransientProgressEvent`.
- Current conversation (non-transient) event types:
  - `user.input`
  - `assistant.output` (only when message text is non-empty)
  - `turn.completed`
  - `turn.error`
- Current non-transient metadata event types:
  - `session.created`
- Current transient event types (known examples):
  - `agent.delta`
  - `command.<state>` (for example `command.started`, `command.completed`)
  - `file.change`
  - `mcp.tool`
  - `item.<type>` fallback event types produced by item summarization
  - `assistant.output` with empty message text
- Rule:
  - Treat transient events as best-effort progress signals only. They may be dropped, reordered, or absent after reconnect/rehydration and must not be used as the sole source for durable UI decisions (session status, turn completion, canonical conversation history, or gating user actions).

### UI Components
- `clients/web/src/components/folder-browser-dialog.tsx`
- Responsibilities:
  - Browse/select allowed working directory via `/api/fs/list`.

- `clients/web/src/components/agent-thread-panel.tsx`
- Responsibilities:
  - Render grouped turn conversation stream.
  - Provide prompt input surface and submit callbacks.

### Shared Types
- `clients/web/src/types.ts`
- Responsibilities:
  - Centralize DTO and UI model typing across entry/component code.

### Styling and Build
- `clients/web/src/styles.css`
- `clients/web/vite.config.ts`
- Responsibilities:
  - UI styling tokens and layout behavior.
  - Vite HMR in dev and static build into `internal/server/webdist` for Go embed serving.
  - `/api` proxy to Go server during local HMR.

## Client-Server Contract Summary
- Transport split:
  - Request/command path: HTTP (`/api/rpc`, `/api/thread/interaction/respond`).
  - Event path: SSE (`/api/thread/events/stream`).
- Resume semantics:
  - Client sends `Last-Event-ID`.
  - Server replays missing thread events from append-only store, then continues live fanout.
- Multi-client behavior:
  - Any client connected to the same thread receives new thread events.
  - Any client may answer interaction requests; resolution is first-write-wins.

## Development Modes
- Embedded bundle mode: `./dev-hot`
  - Rebuild web bundle and Go binary on change, restart server.

## Current Boundaries and Future Extension Points
- Current boundary:
  - Server contains all Codex-process orchestration and event persistence.
  - Web client remains stateless relative to canonical thread history.
- Extension points:
  - Replace file event store with durable DB-backed store.
  - Add authn/authz middleware before API routes.
  - Split web client into multiple platform clients sharing API/SSE contract.
