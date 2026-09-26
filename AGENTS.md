# Repository Guidelines

## Project Overview

Agent-facing notes for `agentboard` — a mobile-first web control board for [herdr](https://herdr.dev) agent sessions (omp/pi, Claude Code, opencode): live fleet, transcript-as-chat, question answering, prompt/steer, spawn, resume, model switch. Private, single package, no monorepo.

`README.md` is the only prose doc and the de-facto spec for behaviour and UI invariants. Read it before changing UI or herdr semantics; this file covers structure, commands and conventions.

## Architecture & Data Flow

One Next.js process serves both UI and API. herdr and the agents run on the host (mounted in under Docker); the board only reads the socket and the agents' session files. No own DB, no worker, no daemon.

```
browser ──(cookie/token)──> proxy.ts ──> app/api/*/route.ts
                                            │
              lib/herdr/rpc.ts   (fresh unix socket per request, newline JSON {id,method,params})
              lib/herdr/stream.ts (ONE long-lived events.subscribe per session, reconnect+backoff)
              lib/herdr/board.ts  (per-session mirror: session.snapshot poll every POLL_MS = 5000 = truth;
                                   events only accelerate, refresh coalesced by MIN_REFRESH_GAP_MS = 1000)
                                            │  BoardState
              app/api/stream/route.ts ──SSE──> components/use-board.ts ──> pages
              lib/chat/* (omp/claude JSONL, opencode sqlite) ──> ChatSession ──> /api/transcript
              lib/chat/watch.ts (fs.watch + 1.5 s stat backstop) ──> /api/tail SSE
```

- Writes go through exactly two paths: `POST /api/prompt` (`agent.prompt`, falls back to `pane.send_input` with a returned `warning`) and `POST /api/action` (allowlist `ALLOWED` in `app/api/action/route.ts:8-57`, 48 methods, 403 otherwise, 30 s default / 300 s max timeout). Both schedule a board refresh.
- The client never mutates board state locally — it waits for the next SSE frame.
- Read routes resolve panes across sessions: `lib/herdr/panes.ts` + `lib/herdr/request.ts` try the `?session=` owner first, then every live session, so a stale `?session=` self-heals instead of 404ing.
- Module-scope caches are keyed on `globalThis` (`__agentboard_boards__`, `__agentboard_chat_cache__`, `__agentboard_models__`, `__agentboard_token__`, `__agentboard_opencode_db__`, `__agentboard_session_rescan__`) because the bundler duplicates module scope per route. `BOARD_BUILD` in `lib/herdr/board.ts` invalidates stale `Board` instances across dev HMR.

### Invariants — do not "fix" these

- **One herdr request per connection.** herdr closes the connection after answering; pooling makes it flap. `rpc.ts` opens a fresh socket per call; only `stream.ts` holds a long-lived connection.
- **Snapshot polling is the source of truth, events are an accelerator.** `pane.agent_status_changed` needs a `pane_id` and `pane_updated` fires several times a second, so the board polls and coalesces. Never add client-side event replay.
- **Never guess an agent session.** `resolveTranscript` (`lib/chat/index.ts`) uses the herdr `agent_session` reference only; missing → explicit message, never "newest `.jsonl` for the cwd" (that behaviour was removed on purpose).
- **Transcripts are read, not re-implemented.** Each agent's own store is parsed into one shape in `lib/chat/*`; unreadable agents fall back to the Terminal tab (`pane.read`).
- **Terminal answers are keystrokes** (option *n* = `down`×n + `enter`; multi-select toggles with `space`, submits with `enter`) — never RPC answers.
- **Session ids are attacker-controlled input.** `lib/herdr/sessions.ts` rejects anything outside its `SESSION_NAME` regex and never derives a socket path from an unvalidated id; a board is never minted for a session id nothing answers to.
- **UI:** sheets (`ConfirmSheet`/`PromptSheet`) instead of `window.confirm`/`window.prompt` (an installed iOS web app silently returns `false`/`null`); `html { font-size: 18px }` in `app/globals.css` is the single size knob; `Button`/`IconButton`/`iconClass` in `components/bits.tsx` are the only buttons (3 sizes, 4 tones, each tone owns its background); form-control resets stay inside `@layer base`; scrollbars are hidden by colour, never width; no bottom navigation.
- **`next.config.ts` sets `agentRules: false`.** That disables Next 16's automatic AGENTS.md rewriting — leave it off, and do not create a second agent-rules file.
- **`proxy.ts` runs on the Edge runtime** — no `node:crypto`, no Node built-ins (hence `crypto.getRandomValues` in `lib/auth.ts`).

## Key Directories

| Path | Purpose |
|---|---|
| `app/` | App Router pages: `page.tsx` (fleet), `a/[pane]/page.tsx` (chat), `new/page.tsx` (spawn) |
| `app/api/*/route.ts` | The whole backend — 11 handlers: `action, agents, models, pane-text, prompt, resume, sessions, state, stream, tail, transcript` |
| `components/` | Client UI: `use-board.ts` (SSE hooks + `callAction`), `chat.tsx`, `bits.tsx` (atoms/sheets), `usage.tsx`, `agent-nav.tsx`, `session-chip.tsx`, `scroll-hider.tsx` |
| `lib/herdr/` | Transport + state: `rpc.ts`, `stream.ts`, `board.ts`, `sessions.ts`, `panes.ts`, `request.ts`, `models.ts`, `names.ts`, `input-line.ts`, `types.ts` |
| `lib/chat/` | Transcript readers: `index.ts`, `omp.ts`, `claude.ts`, `opencode.ts`, `sessions.ts`, `models.ts`, `watch.ts`, `jsonl.ts`, `types.ts` |
| `scripts/` | Standalone `check-*.ts` verification scripts (see Testing & QA) |
| `proxy.ts` | Root-level Next 16 proxy/middleware: token gate + startup banner |
| `.docs/` | Gitignored, local-only: generated herdr 0.9.1 API reference + `herdr-api.schema.json` + screenshots. Regenerate with `herdr api schema`; do not reference it from committed code. |

## Development Commands

Everything runs through Bun (`bun.lock` is the only lockfile).

```bash
bun install
bun run dev          # next dev -p ${PORT:-4317} -H ${HOST:-0.0.0.0}
bun run build
bun run start
bun run typecheck    # tsc --noEmit (NOT part of `check`)
bun run check        # the de-facto test suite, see below
bun run check:sessions       # scripts/check-session-guard.ts
bun run check:session-list   # scripts/check-session-list.ts

AGENTBOARD_TOKEN=$(openssl rand -hex 16) bun run dev   # pin a token
AGENTBOARD_OPEN=1 bun run dev                          # trusted networks only
AGENTBOARD_TOKEN=$(openssl rand -hex 16) docker compose up --build
herdr integration status      # why agent.prompt may fall back to send_input
herdr integration install omp # refresh stale lifecycle hooks (also claude, opencode)
```

- No `test`, `lint`, `format` or `e2e` script, and no linter/formatter config exists. The two gates are `bun run typecheck` and `bun run check`; run both after a change, and exercise the affected route or page in a running app (see Testing & QA).
- Port 4317, host `0.0.0.0` by default; the UI is mobile-first and typically read as an installed web app.

## Code Conventions & Common Patterns

- **Imports:** alias `@/*` → repo root (`tsconfig.json`) in `app/`, `components/`; relative paths (`../json`, `./models`) inside `lib/`. `import type { … }` for type-only imports.
- **TypeScript is strict + `noEmit` + `isolatedModules`**; `**/*.ts` is included, so `proxy.ts` and `scripts/*.ts` are typechecked too. `noUncheckedIndexedAccess` and friends are off — validate at the boundary instead.
- **No validation library.** Narrowing helpers in `lib/json.ts` (`asRecord`, `asArray`, `asString`, `blockText`, `trimMessages`, `projectSlug`) are the convention for parsing untrusted JSON/transcript data.
- **Route handler shape:** thin module with `export const dynamic = "force-dynamic";`, `GET`/`POST` returning `Response.json(payload, { headers: { "cache-control": "no-store" } })`. Logic lives in `lib/`; the session comes from `?session=` / `body.session` via `lib/herdr/request.ts`.
- **Error handling:** typed JSON status codes, never thrown prose — `unknownSession()` → 400, non-allowlisted action → 403, prompt while the agent is blocked at a question → 409, herdr failure → 502. Missing transcripts return an explicit message, not an empty or guessed session.
- **File-header comments are the documented convention.** Nearly every non-trivial module opens with `/** … */` explaining *why* it exists and the invariant it protects (grep `lib/herdr/board.ts`, `lib/auth.ts`, `components/bits.tsx`).
- **Async/state patterns:** server-side singletons cached on `globalThis`; a version constant (`BOARD_BUILD`) to invalidate them under HMR; SSE for push, prefix-diff polling for pull; parse caches keyed on `mtime:size:limit` (`lib/chat/index.ts`).
- **Tailwind v4 CSS-first:** no `tailwind.config.*`; theme tokens live in `app/globals.css` `@theme` (`--color-ink-*`, accent/working/blocked/done/idle). Add tokens there, not in JS.
- **Env vars:** `AGENTBOARD_*` for board options, upstream names kept verbatim (`HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_CONFIG_DIR`, `OPENCODE_DB`). Document new ones in `.env.example`.
- **Naming:** files and routes kebab-case (`app/api/pane-text/route.ts`, `check-session-guard.ts`); hooks `use*`; check scripts `scripts/check-<subject>.ts` exposed as `check:<subject>`.
- **Commits:** `type(scope): lowercase imperative subject`, no trailing period, blank line, then a ~80-col body explaining the race or failure being fixed. Types in use: `feat`, `fix`. Scopes in use: `herdr`, `board`, `chat`, `input-line`, `opencode`, `spawn`, `resume`, `dev`. No trailers. Work lands directly on `main`; no tags, no changelog, version stays `0.1.0`.

## Important Files

| Path | Why |
|---|---|
| `package.json` | Sole command surface; dependency policy (only `next`, `react`, `react-dom`) |
| `next.config.ts` | `agentRules: false`, dev-origin wildcards, `serverExternalPackages: ["node:sqlite"]` |
| `proxy.ts` + `lib/auth.ts` | Token gate and policy (`AGENTBOARD_TOKEN` / `AGENTBOARD_OPEN` / per-process token) |
| `lib/herdr/rpc.ts`, `stream.ts`, `board.ts` | The three transport/state primitives; each encodes one invariant |
| `lib/herdr/sessions.ts`, `input-line.ts`, `names.ts`, `models.ts` | Session guard/discovery, prompt-line parser, agent naming, model candidates — all covered by checks |
| `lib/chat/index.ts` | `resolveTranscript`/`readAgentChat` — the "never guess" rule in code |
| `lib/chat/opencode.ts` | Only `node:sqlite` user → dictates the Node ≥ 22 floor |
| `components/bits.tsx` | Single source of button chrome, sheets, screen shell, status atoms |
| `app/page.tsx`, `app/a/[pane]/page.tsx`, `app/new/page.tsx` | The three screens; all client state flows through `components/use-board.ts` |
| `app/api/action/route.ts` | Method allowlist — the security boundary for herdr mutations |
| `Dockerfile`, `docker-compose.yml` | Supported deployment and its mounts/env (`AGENTBOARD_TOKEN` required there) |
| `tsconfig.json` | Strict TS + the `@/*` alias |

Note: README's `Files` block is a curated map, not an index — it omits `lib/auth.ts`, `lib/herdr/{panes,models,names,request,types,input-line,sessions}.ts`, `lib/chat/{models,watch,jsonl,types}.ts`, `proxy.ts`, `components/*`; and its `components/` line still mentions a "bottom nav" that no longer exists.

## Runtime/Tooling Preferences

- **Package manager: Bun only** (`bun.lock`, `bun install`, `bun run <script>`). Do not add a second lockfile. README requires Bun ≥ 1.4.
- **Server runtime: Node ≥ 22** — `lib/chat/opencode.ts` imports `node:sqlite` (`DatabaseSync`, read-only) and `next.config.ts` marks it external. Docker builds/runs on `node:26-alpine`; dev/checks under `bun` are fine.
- No `engines`, `packageManager`, `.nvmrc`, CI or hooks enforce any of this — nothing runs gates automatically (`.git/hooks/` is stock `*.sample` only). Run them yourself.
- No CI, no Makefile/justfile, no codegen, no migrations. The only generated artifact is the local `.docs/` herdr API reference, produced outside the repo by `herdr api schema`.
- Runtime inputs, all host-side: the `herdr` unix socket under `~/.config/herdr`, `~/.omp/agent/sessions/**`, `~/.claude/projects/**`, `~/.local/share/opencode/opencode.db`, and the model registry `~/.cache/opencode/models.json` (fallback `~/.config/opencode/models.json`). `AGENTBOARD_HOST_HOME` rewrites host paths inside containers.
- Non-goals: live PTY rendering, subagent/sidechain transcripts, per-agent cost dashboards, remote/multi-machine federation.

## Testing & QA

There is **no test framework, no test directory, no CI and no coverage tooling** — deliberately. Verification is five standalone, framework-free scripts run by Bun:

```bash
bun run check   # check-input-line && check-models && check-names && check-session-guard && check-session-list
bun run typecheck
```

| Script | Covers |
|---|---|
| `scripts/check-input-line.ts` | `extractInputLine` (`lib/herdr/input-line.ts`) against captured real omp/claude screens |
| `scripts/check-models.ts` | `parseOmpModels` (`lib/herdr/models.ts`) against an inline `models.yml` fixture |
| `scripts/check-names.ts` | `agentName`/`freeAgentName` slug, uniqueness, 32-char rules |
| `scripts/check-session-guard.ts` | Session-id traversal (incl. `..`, `a/b`, `a\0b`) against the real `state`/`stream`/`action` handlers over fake unix-socket herdr servers; asserts no board is minted for ghost ids |
| `scripts/check-session-list.ts` | `listAgentSessions` + omp/claude/opencode outcome labels over temp fake stores |

`scripts/check-usage.ts <claude.jsonl> <omp.jsonl> <opencode-session-id>` is a manual inspection tool, intentionally not in `check`.

**Writing a new check** (follow the existing shape — no frameworks, no shared fixtures dir):

1. New file `scripts/check-<subject>.ts` with a header `/** Runnable check for …: `bun run check:<subject>`. */`.
2. Use `node:assert/strict`, or a local `check(name, ok, detail)` counter printing `ok   <name>` / `FAIL <name> — <json>`, then `${n}/${total} passed` and `process.exit(failures === 0 ? 0 : 1)`.
3. Fixtures are copies of *real* agent/herdr output; temp state via `fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-…"))` and `fs.rmSync(…, { recursive: true, force: true })` at the end.
4. For socket-dependent modules, set `process.env.HERDR_CONFIG_DIR` **before** dynamically importing `lib/herdr/rpc.ts` (it is read at module load) and serve one JSON line per connection.
5. Append `&& bun scripts/check-<subject>.ts` to the `check` script in `package.json` and optionally expose `check:<subject>`.

Also expected before yielding a behaviour change: run `bun run typecheck`, then exercise the real surface — `bun run dev` and hit the affected route/page (`?token=` from the startup banner, or `AGENTBOARD_OPEN=1` locally). The checks do not cover `components/*`, the pages, `proxy.ts`, `lib/auth.ts`, `lib/json.ts`, `lib/herdr/{rpc,stream,panes,request,types}.ts`, or any `app/api/*` route other than `state`/`stream`/`action`; there is no browser/e2e coverage.
