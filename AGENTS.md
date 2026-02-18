# Repository Guidelines

## Project Structure & Module Organization
This project hosts Codex agents on a local machine and exposes them over HTTP. Use:
- `src/server/` for Bun HTTP server, routing, and bind/port startup.
- `src/agent/` for agent lifecycle logic (spawn, thread state, input, progress).
- `src/fs/` for safe home-directory navigation utilities.
- `src/web/` for the React UI (folder picker, thread view, input box, progress UI).
- `tests/` mirroring `src/` (`tests/server/`, `tests/agent/`, etc.).
- `docs/` for API contracts and architecture decisions.

## Build, Test, and Development Commands
Standardize on Bun scripts in `package.json`:
- `bun install` installs dependencies.
- `bun run dev` starts server + web UI in development.
- `bun run start -- --bind 127.0.0.1 --port 3275` runs the distributable locally on a chosen interface/port.
- `bun run test` runs automated tests.
- `bun run lint` runs TypeScript + lint checks.
- `bun run build` creates the production bundle/binary.

## Agent Runtime Expectations
- Use the official Codex SDK (`@openai/codex-sdk`) for thread/session management.
- Assume local login/auth with Codex has already been completed on the host machine.
- Server endpoints are intentionally unauthenticated for now; deployment assumption is localhost or trusted private network access (for example, Tailscale).

## Coding Style & Naming Conventions
- TypeScript everywhere (`.ts`/`.tsx`), strict mode enabled.
- 2-space indentation, semicolons on, single quotes.
- `PascalCase` for React components and types, `camelCase` for functions/variables, `kebab-case` for file names.
- Keep transport DTOs in explicit types; do not pass untyped JSON through agent boundaries.

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
- Use Bun test runner for unit/integration tests.
- Cover: bind/port parsing, folder traversal safety, agent spawn/stop, thread input handling, and progress event streaming.
- Test names should describe behavior (example: `starts agent when folder is selected`).

## Commit & Pull Request Guidelines
- Use imperative commits with scope: `server: add bind option`, `web: render thread progress`.
- Keep each commit focused on one concern (server, agent, or UI).
- PRs should include:
  - Goal and user-visible behavior.
  - API or protocol changes.
  - Test evidence (`bun run test`, manual steps).
  - Screenshots/GIFs for UI updates.

## Security & Configuration Tips
- Never commit secrets, tokens, or `.env` values.
- Restrict filesystem browsing to intended roots (default: user home).
- Validate and normalize selected folder paths before starting agents.
- Default bind to localhost unless explicitly overridden.
