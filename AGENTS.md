# Repository Guidelines

## Project Structure & Module Organization
This project hosts Codex agents on a local machine and exposes them over HTTP. Use:
- `cmd/darkhold/` for Go application startup and process wiring.
- `internal/server/` for HTTP routing, RPC handling, SSE streaming, and embedded web serving.
- `internal/events/` for append-only thread event storage and rehydration helpers.
- `internal/fs/` for safe home-directory navigation utilities.
- `internal/config/` for bind/port/CIDR parsing and validation.
- `clients/web/` for the React + Vite web client.
- `docs/` for API contracts and architecture decisions.

## Build, Test, and Development Commands
Go server commands:
- `go test ./...` runs Go unit/integration tests.
- `./dev-go-server` builds `clients/web`, builds Go binary, and runs server.
- `./dev-hot` rebuilds embedded web bundle + Go binary on change and restarts server.

Web client commands (scoped to `clients/web`):
- `npm --prefix clients/web install` installs web dependencies.
- `npm --prefix clients/web run dev` starts Vite HMR dev server.
- `npm --prefix clients/web run build` builds static assets into `internal/server/webdist`.
- `npm --prefix clients/web run typecheck` runs web TypeScript checks.

## Agent Runtime Expectations
- Server talks to `codex app-server` over stdio per session.
- Assume local login/auth with Codex has already been completed on the host machine.
- Server endpoints are intentionally unauthenticated for now; deployment assumption is localhost or trusted private network access (for example, Tailscale).

## Coding Style & Naming Conventions
Go server:
- Keep Go code idiomatic and `gofmt`-formatted.
- Keep transport DTOs explicit; avoid untyped payload plumbing where possible.

Web client:
- TypeScript (`.ts`/`.tsx`) with strict mode.
- 2-space indentation, semicolons on, single quotes.
- `PascalCase` for React components/types, `camelCase` for functions/variables, `kebab-case` for file names.

## UI Typography
- Default UI font family: `IBM Plex Sans` (or `IBM Plex Serif` where intentionally used).
- All code surfaces must use `IBM Plex Mono` (inline code, code blocks, terminal views, IDs, and logs).
- Install and serve IBM Plex via npm package assets (`@ibm/plex`); do not use Google Fonts.
- Define these as shared CSS tokens early (example: `--font-ui`, `--font-mono`) and avoid ad-hoc font overrides.

## UI Frameworks
- Use Bootstrap classes for layout and visual styling (`container`, `row`, `card`, `btn`, `badge`, etc.).
- Use Headless UI (`@headlessui/react`) components for interactive/stateful functionality (selectors, dialogs, menus, buttons).
- Keep functionality in Headless UI components and use Bootstrap primarily as the CSS layer.
- Before implementing or modifying any Headless UI or Bootstrap component, read the official documentation page for that exact component/API and follow its recommended structure and behavior.

## Testing Guidelines
- Use `go test ./...` for backend feature coverage.
- Cover: bind/port parsing, CIDR filtering, folder traversal safety, session spawn/stop, thread input handling, interaction respond flow, and SSE event streaming/rehydration.
- Web client checks should include `npm --prefix clients/web run typecheck`.
- Test names should describe behavior (example: `starts agent when folder is selected`).

## Commit & Pull Request Guidelines
- Use imperative commits with scope: `server: add bind option`, `web: render thread progress`.
- Keep each commit focused on one concern (server or web client).
- Do not commit or push unless the user explicitly asks for it in the current conversation.
- PRs should include:
  - Goal and user-visible behavior.
  - API or protocol changes.
  - Test evidence (`go test ./...`, web checks as needed).
  - Screenshots/GIFs for UI updates.

## Documentation Maintenance
- Keep `docs/architecture.md` up to date whenever server runtime behavior, session lifecycle policy, API routing, event streaming semantics, or web-client architecture changes.
- In PRs and commits that change architecture, update docs in the same change set rather than deferring.

## Security & Configuration Tips
- Never commit secrets, tokens, or `.env` values.
- Restrict filesystem browsing to intended roots (default: user home).
- Validate and normalize selected folder paths before starting agents.
- Default bind to localhost unless explicitly overridden.
