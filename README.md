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
`next dev` serves its dev resources only to origins listed in `allowedDevOrigins`: `localhost`, the
hostname, every interface IPv4, plus the wildcard patterns `*.*`, `*.*.*`, `*.*.*.*`, which match any
dotted origin a browser can send — so LAN and tunnelled access needs no configuration. Anything else
(single-label `/etc/hosts` alias, IPv6, `null`) goes in `AGENTBOARD_DEV_ORIGINS`; unlisted origins
load the page without hydrating.

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
| Turn times in the chat: how long each turn took, and a live counter while the agent is still on one | the transcript's own message timestamps |
| Transcripts come from herdr's own `agent_session` reference and nothing else: a pane without one reports the session missing (the Terminal tab still works), never a guess from the pane's directory | `session.snapshot` → `agent_session` → that agent's own session file/db |
| Pending-question cards with option buttons; answers sent as keystrokes | transcript tool calls + `pane.send_keys` / `pane.send_text` |
| Spawn: existing workspace, new workspace, or isolated git worktree; the agent gets a tab of its own; optional first prompt | `tab.create`, `workspace.create`, `worktree.create`, `agent.start` |
| Prompt & steer: composer, Esc/Ctrl-C/arrows, interrupt, rename, zoom, focus, close pane | `agent.prompt`, `agent.send_keys`, `pane.*` |
| Two-way input sync: typing here writes to the agent's prompt as you type, and typing in herdr first appears here (the terminal is the source of truth) | `pane.send_text`/`send_keys`, `pane.read` + input-line parser |
| Attention inbox: blocked/done agents, browser notification + sound, muted toggle. Review focuses the pane on the way into the chat, so herdr's "finished, unseen" state clears | `agent_status` rollups, `pane.focus` |
| Notification panel: permission state, "Send test notification", mute; per-device via localStorage | Web Notifications API |
| Session resume: the ↻ on a workspace lists every agent session there and reopens the one you pick in a new pane; the chat copies `omp --resume <id>` / `claude --resume <id>` / `opencode --session <id>` | `agent_session` refs (or the transcript's own id), `pane.split` + `agent.start` |
| Model switch inside a chat: the chip next to the Chat/Terminal tabs lists the models this machine has (and takes a typed id), then sends the agent's own `/model <id>` so the same session continues (omp, pi, claude) | `/api/models`, `agent.prompt` |

Everything else herdr exposes (`layout.*`, `tab.*`, `worktree.*`, `notification.show`, …) is reachable through
`POST /api/action`, which refuses any method outside an explicit allowlist.

## Design notes

- **One size knob, three button sizes.** Every length in the UI is rem-based, so the root `font-size` in
  `globals.css` scales type, padding and tap targets together; `Button`/`IconButton`/`iconClass` (used by the `+`
  links too) are the only button implementations, in exactly three sizes (`xs` for the glyphs that ride along a
  row, `sm` for compact text actions, `md` for standalone ones) and four tones. A tone owns its background — the
  shared base must not set one, or two equal-specificity `bg-*` utilities decide the colour by stylesheet order.
- **Form-control defaults live in `@layer base`.** `textarea, input, select, button { font: inherit }` has to be
  layered: an unlayered rule beats every layered utility whatever the specificity, so `text-sm`, `font-semibold`
  and `text-ink-950` on a button silently did nothing while that rule sat outside a layer.
- **Destructive taps and renames ask in a sheet, never `window.confirm`/`window.prompt`.** An installed iOS web
  app — how this board is read on a phone — answers `confirm` with `false` and `prompt` with `null` while showing
  no dialog at all, so a tap gated on either is a dead button that also reports success. `ConfirmSheet` and
  `PromptSheet` are the same question in the app's own chrome, where the user can see it.

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
  (`lib/herdr/input-line.ts`, covered by `bun run check`) and adopts it when herdr owns the typing. Only the
  bottom-most box on screen counts as the prompt: omp's welcome panel is box-shaped too, and walking up from an
  empty prompt used to serve its tips as a draft (which the mirror then typed into the agent). While the
  composer has unsent local edits it never fights you, and it pauses entirely when a question dialog owns input.
  A newline you type is sent as the agent's own newline chord (`shift+enter`) rather than Enter, so a multiline
  draft does not submit itself; shells get the raw newline. A draft you have typed here is never overwritten by
  the terminal: while the board holds unsent text, and whenever the terminal only shows the tail of a scrolled
  box, the polled text is ignored.
- **Long transcripts do not re-render for nothing.** A poll whose payload says nothing new keeps the previous
  parsed object, so React bails out; an idle agent's chat view produces zero DOM mutations between changes.
- **The fleet has no session filter.** Every session is always listed; a chat link carries `?session=` (named in
  the chat's pane-controls sheet), and the spawn form has its own page-local session picker. There is no bottom
  navigation — the per-workspace `+` is the way to start an agent, and every page has a back link.
- **Panes resolve across sessions.** Read routes (`transcript`, `pane-text`, `input-line`) look the pane up in the
  requested session first and then in every other live session, returning the session that actually owns it — a
  link with a missing or stale `?session=` self-heals instead of 404ing, and the page adopts the answer.

A freshly started agent has no transcript yet: herdr names the file, the agent writes it on its first turn. The
chat view says "No messages yet — this agent has not taken its first turn" and the tail watcher attaches when the
file appears, so the first message shows up without a reload.

`agent_session` may be missing entirely, and the board never fills the gap by guessing. herdr learns a session
only from the agent's own lifecycle integration, and that integration reports it **once, at startup**
(`pane.report_agent_session`); an agent started before its integration was installed therefore has no session
until it is restarted. Such a pane says exactly that — "herdr has no session reference for this pane: the agent's
integration reports one when it starts, so restart the agent and check `herdr integration status`" — and the
Terminal tab still shows the pane. Pick the session from disk instead? That was the old behaviour (newest
`*.jsonl` for the pane's cwd) and it was removed: with two agents in one project it can only show one of them,
and a wrong transcript is worse than a named absence. Answers are always sent as keystrokes, so the question card
works either way.

Resume reads the same reference and nothing else — hence the ↻ sheet lists each agent's own session id, marks the
panes herdr never got one for, and refuses to resume them. Only the session **id** is used from the reference: omp
names files `<timestamp>_<id>.jsonl` and Claude Code names them `<id>.jsonl`, while every resume flag takes the id
(`claude --resume <path>` is not a session), so a path reference is reduced to its last underscore-suffixed
segment.

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
scripts/check-*.ts       `bun run check`: input-line parser, models.yml subset
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
