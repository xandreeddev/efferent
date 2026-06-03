# @efferent/cli

Coding-agent driver — composition root for four modes, plus a hand-rolled TUI.

## Layout

```
packages/cli/src/
├── main.ts            @effect/cli command + Layer composition + mode dispatch
├── events.ts          AgentEvent union + makeEventHooks(queue, extraBeforeTool?)
├── modes/
│   ├── tui.ts         full-screen TUI driver (TTY default)
│   ├── print.ts       one-shot, streams final text to stdout
│   ├── json.ts        same loop as print but JSONL events on stdout
│   └── rpc.ts         bidirectional JSON-RPC over stdio
└── tui/
    ├── terminal.ts    raw mode, ANSI escapes, alt buffer, getTermSize
    ├── keys.ts        stdin byte → discriminated Key event parser
    ├── render.ts      diffing frame composer (status + scrollback + palette + input + modal)
    ├── statusBar.ts   model + token gauge + cwd (exports formatTokens/gauge)
    ├── scrollback.ts  ●/⎿ event rail: user turn / assistant / tool / diff / info / error blocks
    ├── sidePane.ts    "activity" dashboard (stats + tree + files/skills/instructions) + context viewer
    ├── toolDescribe.ts pure ToolName(arg) labels + result summaries + artifacts
    ├── input.ts       multi-line editor (Enter/Ctrl-J newline in INSERT; submit from NORMAL via Enter)
    ├── slashPalette.ts /<cmd> autocomplete overlay
    ├── modal.ts       generic centered y/n confirm
    ├── selectBox.ts   reusable navigable select overlay (`:model`, `:login` menus)
    ├── promptBox.ts   reusable masked single-line input overlay (API-key / paste)
    ├── loginFlow.ts   pure `:login` state machine (authMethod → provider → key/oauth)
    └── markdown.ts    minimal markdown → ANSI converter
└── login/oauthServer.ts   loopback OAuth callback server + open-browser helper
```

## Rules

- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@efferent/core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Shell | Llm | ConversationStore>` that subscribes to the agent's event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap the LLM provider, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants

- **Modal + multi-pane** (vim-flavoured). Regions top→bottom: middle (**two separate bordered boxes** — conversation and side — with **one empty column between them**), the **bordered keybind box**, overlay (`:` palette OR `/` search), input box, status bar, dim footer (logs path + key hints). Input is pinned above the status/footer.
- **Per-pane accent colours.** The focused box's border + title brighten to that pane's accent: **conversation = bright cyan, side = bright magenta, input = bright green** (unfocused = dim gray). `PANE_ACCENT` in `render.ts`; `bcol/hseg/vbar/dashes/corner` take an `accent`. The keybind box's border + title use the **currently-focused** pane's accent, and its title carries `<pane> · <MODE>` (e.g. `conversation · NORMAL`) — the **only** place the vim mode is shown (the status bar is `model · tokens · storage · cwd`, where `storage` is the active store `sqlite`/`pg`; no mode/pane).
- Three focusable panes (conversation / side / input) swapped with **Ctrl-h/j/k/l or Ctrl-arrows** (peers — a non-moving Ctrl-arrow falls back to that pane's in-pane motion). INSERT only on the input; NORMAL + VISUAL on the read-only panes. NORMAL: j/k · Ctrl-D/U · PgUp/PgDn · gg/G · {/} scroll, Home/End line ends, `/` search (n/N), `:` commands. Arrow keys are full peers of hjkl everywhere — including the side pane, where ←/→ fold a node just like h/l. VISUAL: `v` select, `y` yanks to clipboard (OSC 52). No mouse tracking — native click-drag selection still works. See `SCOPE.md` for the full spec.
- The **keybind box** is **two labelled rows** (`legend.ts`): a dim **`nav`** row (the global movement set — pane switching / `:` / `/` / zoom, identical in every pane) over a dynamic row of the focused pane's own keys. A `:`/`/` entry takes the top row (`cmd`/`find`) and blanks the bottom one.
- Renders are full-frame composed then line-diffed against the previous frame to avoid flicker.
- Raw mode + alt buffer + bracketed-paste; restored on exit (Ctrl-C, `:exit`, signal).
- Bash safety: non-interactive modes gate on `--allow-bash` (the `allowBash` flag flows into `codingToolkitLayer`; a denied call returns to the model as a tool failure). The TUI currently allows bash unconditionally — a `promptForBash` modal is defined in `tui.ts` but **not yet wired** into `onBeforeToolCall` (see `docs/roadmap.md`).

## Hardcoded knobs (move to a settings layer later)

- Bash timeout default (in `coderAgentConfig` tools): 60s.
- TUI palette: 6 visible rows, `:` commands hardcoded in `slashPalette.ts`.
- maxSteps for the agent loop: default 20 (`Settings.maxSteps`; `runAgentLoop` falls back to 20).
- Conversation store: SQLite at `~/.efferent/efferent.db` by default; `EFFERENT_DB_URL` (a `postgres://…` URL → Postgres, any other value → SQLite at that path) or a `dbUrl` in `~/.efferent/config.json` selects otherwise — env wins, config is seeded into the env at boot (`seedDbUrlFromConfig` in `main.ts`; `parseDbTarget`/`ConversationStoreLive` in `adapters/src/database/migrator.ts`).
- Setup / credentials: there is **no first-run wizard and no `init`** — `efferent` always boots into the TUI and you add a provider in-session with **`:login`** (`loginFlow.ts`: *Use a subscription*/OAuth or *Use an API key* → provider → masked key or browser OAuth). Credentials live only in `~/.efferent/auth.json` via the `AuthStore` port; **no env-var key reading**. The router resolves the key per turn, so a login takes effect immediately (no restart). `:logout <provider>` removes one. With no credential the TUI shows a `:login` warning and the send-gate short-circuits; non-interactive modes exit with the same hint. OAuth subscription (Anthropic) uses `login/oauthServer.ts` (callback on :53692) + `adapters/src/auth/oauth/anthropic.ts`.
- Storage: the status bar shows the active store (`sqlite`/`pg`). `:db` shows it (`describeActiveDatabase`) or sets it — `:db pg <url>` / `:db sqlite [path]`, with a trailing `global` to write `~/.efferent/config.json` instead of the project `<cwd>/.efferent/config.json`; the store binds at boot, so a change applies on the next launch. `:settings` also reports the active store (Postgres password masked). Neither `dbUrl` is in `:set`.
