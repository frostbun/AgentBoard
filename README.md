# AgentBoard

Mobile-first control board for [herdr](https://herdr.dev) agents (omp, Claude Code, opencode, …).
Spawn agents, read their real transcripts as a chat, answer their questions, and steer panes from a phone.

```
bun install
bun run dev
```

`HOST` defaults to `0.0.0.0`, so the board is reachable from your phone. Since the LAN can reach it
too, access is gated: without `AGENTBOARD_TOKEN` a token is generated per run and printed with a
ready-to-tap URL on the first request.

```
AgentBoard: http://192.168.1.42:4317/?token=ab_1f…      ← open this (the cookie keeps you in)
  token: ab_1f…
  Set AGENTBOARD_TOKEN to pin one, or AGENTBOARD_OPEN=1 to drop the check.
```

Pin a token so scripted access survives restarts, or drop the gate on a trusted network:

```
AGENTBOARD_TOKEN=$(openssl rand -hex 16) bun run dev
AGENTBOARD_OPEN=1 bun run dev        # no auth: anyone who can reach the port controls your agents
```

`/api/*` answers `401` without the token or cookie; a token can also be passed as `?token=`.
`next dev` serves its dev resources only to origins listed in `allowedDevOrigins`, which is built from
`127.0.0.1`, `localhost`, the hostname, and every non-internal IPv4 — otherwise LAN pages load without
hydrating.

## Requirements

- herdr server running (developed against 0.9.1, protocol 22)
- Bun ≥ 1.4 (package manager + script runner; the server runs on Node ≥ 22 because it uses `node:sqlite`)

Socket discovery: `HERDR_SOCKET_PATH` (herdr injects this into its panes, so running the board from inside a
herdr pane needs no config) → `HERDR_SESSION` → newest live socket under `~/.config/herdr`.

The board mirrors **all** sessions at once (`/api/stream?scope=all`): the fleet lists them as sections, the
Needs-you inbox merges them, and each link carries its session (`/a/<pane>?session=<id>`). The ⇄ chip filters
to a single session, or switches a chat/spawn page; the choice is per device.

Transcript updates are pushed, not polled: the server watches the agent's session file (`fs.watch` + stat
backstop) and ticks `/api/tail`, so agent output lands in the UI in ~50 ms. Polls remain as slow fallbacks and
pause while the tab is hidden.

## What it does

| Area | herdr API used |
| --- | --- |
| Live fleet: **session → workspace → agents**, every herdr session at once, with status, title, cwd, and time since the last real change (tracked server-side, so reloads do not reset it) | `session.snapshot` + `events.subscribe` per session |
| Search box: filters agents by name, title, cwd, pane id, workspace, or session; non-matching workspaces collapse | client-side over the federated stream |
| `+` on every workspace **and on every session header** (a fresh session has no workspace to hang one on): opens the spawn form with that session — and workspace, when there is one — preselected | `/new?session=…[&workspace=…]` |
| `+ New session` at the bottom of the fleet: starts `herdr --session NAME server` (creates it if new), lists sessions that exist but are not running so they can be started again | `POST /api/sessions` |
| Chat view: native transcript (not a terminal dump), tool calls, thinking, errors | `~/.omp/agent/sessions`, `~/.claude/projects`, `~/.local/share/opencode/opencode.db` |
| Usage bar per agent: tokens in/out/reasoning, cache read/write and hit rate, cost, provider time, wall clock, context used against the model's window | each agent's own session file |
| Transcript discovery when herdr has no session reference: newest session file for the pane's cwd (labelled "inferred" in the UI) | `agent_session` ref → cwd scan |
| Pending-question cards with option buttons; answers sent as keystrokes | transcript tool calls + `pane.send_keys` / `pane.send_text` |
| Spawn: existing workspace, new workspace, or isolated git worktree; optional first prompt | `pane.split`, `workspace.create`, `worktree.create`, `agent.start` |
| Prompt & steer: composer, Esc/Ctrl-C/arrows, interrupt, rename, zoom, focus, close pane | `agent.prompt`, `agent.send_keys`, `pane.*` |
| Two-way input sync: typing here writes to the agent's prompt as you type, and typing in herdr first appears here (the terminal is the source of truth) | `pane.send_text`/`send_keys`, `pane.read` + input-line parser |
| Attention inbox: blocked/done agents, browser notification + sound, muted toggle. Review focuses the pane on the way into the chat, so herdr's "finished, unseen" state clears | `agent_status` rollups, `pane.focus` |
| Notification panel: permission state, "Send test notification", mute; per-device via localStorage | Web Notifications API |
| Session resume: copy `omp --resume <id>` / `claude --resume <id>` / `opencode --session <id>` | `agent_session` refs |

Everything else herdr exposes (`layout.*`, `tab.*`, `worktree.*`, `notification.show`, …) is reachable through
`POST /api/action`, which refuses any method outside an explicit allowlist.

## Design notes

- **One herdr request per connection.** herdr answers a request and closes that connection (the shipped CLI does
  one request per process). Pooling a request connection makes it flap, so `lib/herdr/rpc.ts` opens a fresh
  connection per call and `lib/herdr/stream.ts` owns the single long-lived `events.subscribe` connection.
- **Snapshot polling is the source of truth, events are an accelerator.** `pane.agent_status_changed` cannot be
  subscribed globally (it requires a `pane_id`) and `pane_updated` fires several times a second for spinners, so
  the board polls `session.snapshot` every 5 s and refreshes (coalesced to ≥1 s) on relevant events. No
  client-side event replay to get out of sync.
- **Transcripts are read, not re-implemented.** Each agent's own session file/database is parsed into one
  normalized shape (`lib/chat/*`), including pending `ask`/`AskUserQuestion` tool calls, which become answerable
  cards. Agents without a reader fall back to the Terminal tab (`pane.read`).
- **Markdown in transcripts is rendered**, including GFM tables, fenced code, headings, lists, inline code, bold, and links.
- **Terminal answers are keystrokes.** Option *n* is `down`×n + `enter`; multi-select toggles with `space` and
  submits with `enter`. The button labels show exactly what gets sent.
- **Input sync is bidirectional and always on.** The board diffs what you type and sends only the delta
  (backspaces for deletions); a 1.3 s poll parses the agent's input line out of the rendered screen
  (`lib/herdr/input-line.ts`, covered by `bun run check`) and adopts it when herdr owns the typing. While the
  composer has unsent local edits it never fights you, and it pauses entirely when a question dialog owns input.
  A newline you type is sent as the agent's own newline chord (`shift+enter`) rather than Enter, so a multiline
  draft does not submit itself; shells get the raw newline. A draft you have typed here is never overwritten by
  the terminal: while the board holds unsent text, and whenever the terminal only shows the tail of a scrolled
  box, the polled text is ignored.
- **Long transcripts do not re-render for nothing.** A poll whose payload says nothing new keeps the previous
  parsed object, so React bails out; an idle agent's chat view produces zero DOM mutations between changes.
- **The fleet has no session filter.** Every session is always listed; a chat link carries `?session=` and shows a
  read-only chip, and the spawn form has its own page-local session picker. There is no bottom navigation — the
  per-workspace `+` is the way to start an agent, and every page has a back link.
- **Panes resolve across sessions.** Read routes (`transcript`, `pane-text`, `input-line`) look the pane up in the
  requested session first and then in every other live session, returning the session that actually owns it — a
  link with a missing or stale `?session=` self-heals instead of 404ing, and the page adopts the answer.

A freshly started agent has no transcript yet: herdr names the file, the agent writes it on its first turn. The
chat view says "No messages yet — this agent has not taken its first turn" and the tail watcher attaches when the
file appears, so the first message shows up without a reload.

`agent_session` may be missing entirely (an uninstalled or outdated herdr integration for that agent). The board
then resolves the transcript from the pane's working directory — newest `*.jsonl` under
`~/.claude/projects/<slug>` or `~/.omp/agent/sessions/<slug>` — and marks the view "transcript inferred from this
pane's working directory". Answers are always sent as keystrokes, so the question card works either way.

## Integrations (why `agent.prompt` may fall back)

`agent.prompt` only works while herdr's lifecycle integration for that agent reports it as ready. Check:

```
herdr integration status
```

Outdated hooks (e.g. `omp v9 < v10`, `opencode v11 < v12`, `claude v9 < v10`) leave the agent in
`launch_pending`, and herdr then rejects prompts with `agent_not_ready`. Refresh them with:

```
herdr integration install omp      # and: claude, opencode, …
```

The board keeps working either way: `POST /api/prompt` retries as `pane.send_text` + `enter` and returns a
`warning` the UI shows.

## Files

```
app/                     fleet (/), chat (/a/[pane]), spawn (/new), api routes
components/              chat renderer, fleet bits, bottom nav, SSE hook
lib/herdr/rpc.ts         one-shot request over a dedicated socket
lib/herdr/stream.ts      long-lived events.subscribe stream with reconnect
lib/herdr/board.ts       in-memory mirror: snapshot polling, attention, SSE fanout
lib/chat/                omp / claude / opencode transcript readers → ChatSession
lib/json.ts              pure narrowing helpers shared by server and client
.docs/herdr-api-reference.md   generated from `herdr api schema` (0.9.1)
```

## Usage numbers

The bar under an agent's header is computed from the session file itself — no extra API calls:

| | omp | Claude Code | opencode |
| --- | --- | --- | --- |
| per turn | `usage{input,output,reasoningTokens,cacheRead,cacheWrite,cost{total}}`, `duration`, `ttft`, `contextSnapshot.promptTokens` | `message.usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` | `message.data.tokens{total,input,output,reasoning,cache{read,write}}`, `cost`, `time` |
| session totals | summed over turns | `cost-state` (`totalCostUSD`, `totalAPIDuration`, `totalToolDuration`, `totalDuration`, `modelUsage`) | `session` row (`cost`, `tokens_*`), falling back to message sums per field |
| live context | `contextSnapshot.promptTokens` | last prompt's input + cache read + cache creation | last message's `tokens.total` |
| context window | models.dev registry (`~/.cache/opencode/models.json`), exact id then version-normalised sibling — estimates are marked `(est.)` | same | same |

`bun scripts/check-usage.ts <claude.jsonl> <omp.jsonl> <opencode-session-id>` prints each reader's aggregation for a real file.

Scrollbars are hidden by **colour**, never by width: toggling `scrollbar-width` changes the content width,
which re-wraps long paragraphs and makes blocks jump around while scrolling. The gutter is reserved
(`scrollbar-gutter: stable`) and only the thumb's colour changes.

## Notifications

The board fires one browser notification (plus a two-tone chime) per pane that enters `blocked` or `done`, and
lists them in the Needs-you inbox. Tap the bell to open the panel: permission status, **Send test notification**,
and the mute toggle (per device, stored in `localStorage`).

Caveats worth knowing:

- The tab must be **open** — there is no service worker and no web push, so a closed tab notifies nothing.
- iOS only delivers web notifications to an **installed** web app: Share → Add to Home Screen, then open from
  there. A plain Safari tab gets nothing, which the panel says explicitly.
- Permission must be requested from a tap (the panel's "Allow notifications"); browsers ignore or permanently
  deny an automatic request, which is why the board never asks on its own.

Only agents are listed; shell-only panes are hidden (start an agent in a pane to see it here).

## Not included (yet)

Live PTY rendering (needs herdr's binary endpoint protocol — the Terminal tab shows `pane.read` text instead),
subagent/sidechain transcripts, per-agent cost dashboards, and remote/multi-machine federation
(`herdr --machine`).
