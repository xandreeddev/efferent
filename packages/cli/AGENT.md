# efferent — the CLI driver (`@xandreed/cli`)

The efferent CLI driver — composition root for the run modes + daemon, plus the OpenTUI/SolidJS TUI. Published as the unscoped npm package **`efferent`** (and the scoped alias **`@xandreed/cli`**, same bundle).

## Layout

```
packages/cli/src/
├── main.ts            @effect/cli command + Layer composition + mode dispatch
├── events.ts          re-export shim → @xandreed/sdk-core (AgentEvent + makeAgentEventHooks/makeEventHooks live in core usecases/eventHooks.ts)
├── terminal.ts        OSC-52 + spinner-frame + ANSI/width helpers (shared infra; print mode uses it too)
├── prompts/           web prompt (web.ts); coder.ts is a re-export shim → @xandreed/sdk-core/prompts/coder.ts (`coderPrompt` moved to core so drivers like @xandreed/smith build the real coder without the CLI)
├── usecases/          teamAgents (the built-in fleet) · importAgents · directive (withBuiltinAgents/VERIFIER_AGENT + shims); coderAgentConfig · loadAgents/loadMemory/loadSkills · discoverInstructionFiles · stripLeads are re-export shims → @xandreed/sdk-core
├── workspace/         the in-process Workspace runtime: inProcess.ts (JobController/submitJob + the stranded-node sweeper) · headlessApproval.ts (the cron parking approval)
├── server/            daemon-serve HTTP/SSE host
├── web/               the `efferent web` driver (NO Solid/OpenTUI imports): model.ts (framework-free keyed cache) · reduce.ts (event→model, the pump switch ported) · render.ts (the ONE @xandreed/web import: Patch→OOB fragments) · pump.ts (makeFragmentPump — Workspace + session id only) · server.ts (HttpRouter + WS upgrade, token→cookie auth) · mode.ts (composition root)
├── modes/
│   ├── tui.ts         just the TuiModeInput seam (driver lives in cli/)
│   ├── print.ts       one-shot, streams final text to stdout
│   ├── json.ts        same loop as print but JSONL events on stdout
│   ├── rpc.ts         bidirectional JSON-RPC over stdio
│   └── daemon.ts      headless cron scheduler (--mode daemon); daemon-serve runs server/ (the `efferent daemon start`/`serve` subcommand)
├── cli/         the TUI driver — OpenTUI native renderer + SolidJS (no React)
│   ├── runtime.ts     composition root + the Effect⇄Solid⇄OpenTUI three-runtime bridge
│   ├── state/         signal slices (conversation · side · session · ui · overlay)
│   ├── events/        Effect→signal event pump (drains the AgentEvent queue)
│   ├── actions/       signal→Effect use-cases (submit · session · search · login · …)
│   ├── keys/          ParsedKey adapter + root dispatch + overlay-first routing
│   ├── commands/      `:` command dispatch
│   ├── view/          App.tsx + panes/ + panes/side/ + chrome/ + overlays/ + ui/ (.tsx)
│   │   └── ui/        token-driven view primitives (Pane · Modal · Rule · Cursor · Marker · RailLine · SectionHead)
│   └── presentation/  L1 — PURE presentation models + state machines (no Solid, no OpenTUI)
│       ├── theme/     design system: palette → tokens (semantic) · glyph · themes (palette.ts·tokens.ts·glyphs.ts·themes.ts·index.ts)
│       ├── conversation.ts  rail block model: turn/tool-group/fold tree (ScrollbackBlock)
│       ├── statusBar.ts model + token gauge + cwd (formatTokens/gauge + StatusState)
│       ├── sidePane.ts "activity" + context-viewer STATE + cursor/fold reducers
│       ├── contextView.ts context segments + turn/handoff selection model
│       ├── executionTree.ts sub-agent / tool execution-tree model
│       ├── toolDescribe.ts pure ToolName(arg) labels + result summaries + artifacts
│       ├── slashPalette.ts `:` command catalogue + computePalette
│       ├── selectBox.ts   pure SelectState (`:model`/`:login` menus)
│       ├── promptBox.ts   pure PromptState (masked API-key / paste)
│       ├── settingsView.ts pure SettingsState (`:settings` table)
│       ├── loginFlow.ts   pure `:login` state machine (authMethod → provider → key/oauth)
│       ├── dbStatus.ts    active-store label/describe helpers
│       └── logger.ts      file logger layer
└── login/oauthServer.ts   loopback OAuth callback server + open-browser helper
```

`presentation/` is the TUI's L1 — pure shapes + reducers/derivations, no Solid or OpenTUI imports
(it was the old `tui/` folder, renamed so the tree no longer reads as two TUIs; `model/conversation.ts`
folded in). `terminal.ts` is shared terminal infra and lives at `src/` (a non-TUI mode imports it),
not under `presentation/`.

**Design system** (`presentation/theme/`, pure L1) is two-tier: `palette.ts` names every raw hex
**once**; `tokens.ts` exports the semantic `tokens` (the stable interface views paint against —
`accent`/`text`/`state`/`marker`/`match`/`overlay`/`status`/`syntax`) plus `makeTokens(palette)` and
`paneBorder`; `glyphs.ts` exports `glyph` (named box-drawing/marker chars). A **theme is one complete
set of token values** (`themes.ts`: `Theme = { name, tokens }`) — same token names across themes,
different values. `presentation/theme/` is **pure + static** (its `tokens` is a const). Runtime
switching lives one layer out in **`state/theme.ts`** (L2): a process-global active-theme Solid signal,
plus a **Proxy-backed reactive `tokens`/`paneBorder`** every view imports — so **`:theme`** (picker like
`:model`, or `:theme <name>`) swaps the whole UI live with **zero token call-site changes** (consumers
still write `tokens.text.default`). Ships `one-dark` + `tokyo-night`; the choice persists to `config.json`
(`Settings.theme`) and is seeded at boot in `runtime.ts`. `view/syntax.ts`'s `SyntaxStyle` is built from
`tokens.syntax` and **memoised per theme name** so fenced code + diff hunks follow a switch. **No raw hex
or glyph literal lives outside `presentation/theme/`.** The reusable painters in **`view/ui/`** (`Pane`,
`Modal`, `Rule`, `Cursor`, `Marker`, `RailLine`, `SectionHead`) are the only components that draw
borders/surfaces/glyphs; every pane/overlay composes them.

## Rules

- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@xandreed/sdk-core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Shell | Llm | ConversationStore>` that subscribes to the agent's event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap the LLM provider, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- **Subcommands are the run-path surface** (`main.ts`): **`efferent`** (no subcommand) is the default master TUI — attach-or-spawn the per-workspace daemon (split process; `EFFERENT_LOCAL=1` forces the in-process driver, `EFFERENT_REMOTE` is the explicit remote alias); **`efferent code`** runs the focused single-fleet coder IN-PROCESS (in-memory Workspace, `variant: "code"`) — the bundled coding agent without a daemon, replacing the deleted `code` bin / `--code` flag / `dist/code.js` shim; **`efferent attach`** explicitly attaches the master TUI to the daemon (auto-spawn if absent); **`efferent daemon start`** (alias **`serve`**; was `--mode daemon-serve`) runs the persistent HTTP/SSE daemon, with **`efferent daemon status`** / **`efferent daemon stop`** for lifecycle; **`efferent verify`** runs the graded acceptance battery (`src/verify/` — Tier A deterministic boot/UI-flow/daemon checks, Tier B keyed turns, Tier C eval smoke; `--target source|commit:<sha>|release:<ver>`) and **`efferent eval`** forwards to the evals runner (`verify`/`eval` are reserved first-token words like `code`/`attach`/`daemon`). The headless `efferent "<prompt>"` / `--mode json|rpc|daemon` paths are unchanged.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants

- **Borderless, single message region** (agy direction), rendered by OpenTUI (Yoga/flexbox `<box>`/`<text>`/`<scrollbox>`/`<textarea>`, plus native `<markdown>` for assistant prose and `<diff>` for `edit_file` diffs, both **tree-sitter syntax-highlighted** for fenced code + hunks — `view/syntax.ts` holds the combined `SyntaxStyle` + the best-effort `getTreeSitterClient()` accessor (worker destroyed by `runtime.ts` on exit); grammars ship with `@opentui/core` (JS/TS/markdown/zig) and `web-tree-sitter` is a declared runtime dep), not hand-drawn. Regions top→bottom: a one-line **header**, then a **chat-first split** — the **chat** on the LEFT (the assistant's conversation, or a jumped-into agent's live session) and the always-visible **fleet tree** on the RIGHT (`FleetTree` → `ContextTreeView` + `NodeDetail`: the CURRENT session as a single always-expanded root → its coordinator/agents/sub-agents with live `●`/`✓`/`✗` status; no tabs, no multi-session list — other sessions are reached via `:browse`/resume) — then the **agy bottom chrome** (top→bottom): the **running loader** (`view/chrome/RunningLoader.tsx` — a `⣻ thinking 4s` spinner line, the live agent-state machine, shown directly above the input while a turn is in flight), the pending queue, the **input fence** (`> ` prompt between two full-width rules, no box — `view/ui/InputFence.tsx`), the `:` command palette / `/` search line **below** the fence, and the **two-row status bar** (row 1 hint + gauge/cache/storage/cwd; row 2 the three model roles `general · code · fast` with the active one highlighted). **No pane borders, no sidebar column, no floating modals**: every contextual surface (`:model`/`:login`/`:settings`/`:theme`/shortcuts/the bash-approval sheet) renders **borderless inline** in the bottom chrome via the `Sheet`/`BottomMenu` primitives; `:onboarding` is the lone full-screen takeover.
- **Accents, not borders.** The input fence's rules + the `> ` caret tint to the input accent when focused; the caret **recolours by composer mode** (message = input/green, `:`-command = side/magenta, `/`-search = conversation/cyan). The two-tier design system in `presentation/theme/` (`palette` → semantic `tokens` + `glyph`) is the **only** source — no raw hex or box/marker glyph literal lives outside it. `view/ui/` primitives (`Pane` borderless container · `Sheet` · `BottomMenu` · `InputFence` · `MenuRow` · atoms) are the only components that paint surfaces/glyphs.
- Three focus targets (chat / fleet tree / input) swapped with **Tab** (and **Ctrl-h/j/k/l or Ctrl-arrows**); the focused pane's edge/title brightens to its accent. The fleet tree is a fixed pane (no `v`-cycle, no view tabs — that four-view model is gone). The input is INSERT, the read-only chat + fleet tree are NORMAL with a **vim-style fold cursor** over `presentation/paneNav.ts` rows (`{}`/`[]` paragraph/message, `gg`/`G` ends, `⇥`/`↵`/`h`/`l` fold the unit — **charwise `w/b/e` + VISUAL deferred**; see `docs/roadmap.md`). Conversation NORMAL: j/k·↑↓ **scroll** · Ctrl-D/U half · PgUp/PgDn · the fold cursor tints + scrolls the current unit · `Z` fold-all · `/` search (n/N · Esc) · `y` yank. **`Ctrl-C` 2×-to-quit.** (No zoom — the single region makes it moot.)
- **Selection/yank uses OpenTUI's native mouse** (`useMouse:true`): drag-select highlights, `y` (read-only panes) copies the selection via OSC 52 (`renderer.copyToClipboardOSC52`). The input `<textarea>` owns its own selection/edit while typing.
- Keybind discovery is the **`?` shortcuts overlay** (`view/overlays/Shortcuts.tsx` + `presentation/shortcuts.ts`), not a persistent box.
- The renderer (alt buffer / raw mode / mouse / frame loop) is OpenTUI's, wrapped in an `Effect.acquireRelease` so the terminal is restored on success, failure, AND interruption.
- Bash safety is **three layers** (all wired): the static `--allow-bash` gate (the `allowBash` flag flows into `codingToolkitLayer`; a denied call returns to the model as a tool failure), the **`Approval` port** (`sdk-core/ports/Approval.ts`) consulted per command from the loop, fronted by the **fast-tier auto-approval judge** (`sdk-core/usecases/autoApproval.ts`). An unmatched command goes to the judge — allow silently, or prompt the **borderless approval sheet** (`cli/approval.ts` + `view/overlays/ApprovalView.tsx`: `a/s/p/d`). Evals/CI use an allow-all impl behind `--allow-bash`; the **unattended cron path** (`--mode daemon`) uses a **headless parking approval** (`workspace/headlessApproval.ts`) — the judge still auto-approves in-scope work, but anything it can't clear emits a **`needs_human`** event (`parked: true`) and is denied-with-reason, never silently allowed. Interactive prompts emit the same event (`parked: false`); the TUI rolls both into a "decisions need you" roster (`view/chrome/DecisionsBar.tsx` + `state/decisions.ts`).

## Hardcoded knobs (move to a settings layer later)

- Bash timeout default (`DEFAULT_BASH_TIMEOUT_MS` in `codingToolkit.ts`): **5 min**, agent-overridable via the `timeout` param; kept independent from the verifier's 30-min `EFFERENT_VERIFY_TIMEOUT_MS` (they share `Shell.exec` but never a default). For work that should outlive a call, the agent uses `Bash(run_in_background)` (+ `bash_output`/`kill_bash`) or a tmux `session_*` instead of a long timeout.
- TUI palette: 6 visible rows, `:` commands hardcoded in `slashPalette.ts`.
- maxSteps for the agent loop: default 20 (`Settings.maxSteps`; `runAgentLoop` falls back to 20).
- Conversation store: SQLite at `~/.efferent/efferent.db` by default; `EFFERENT_DB_URL` (a `postgres://…` URL → Postgres, any other value → SQLite at that path) or a `dbUrl` in `~/.efferent/config.json` selects otherwise — env wins, config is seeded into the env at boot (`seedDbUrlFromConfig` in `main.ts`; `parseDbTarget`/`ConversationStoreLive` in `adapters/src/database/migrator.ts`).
- Setup / credentials: there is **no first-run wizard and no `init`** — `efferent` always boots into the TUI and you add a provider in-session with **`:login`** (`loginFlow.ts`: *Use a subscription*/OAuth or *Use an API key* → provider → masked key or browser OAuth). Credentials live only in `~/.efferent/auth.json` via the `AuthStore` port; **no env-var key reading**. The router resolves the key per turn, so a login takes effect immediately (no restart). `:logout <provider>` removes one. With no credential the TUI shows a `:login` warning and the send-gate short-circuits; non-interactive modes exit with the same hint. OAuth subscription (Anthropic) uses `login/oauthServer.ts` (callback on :53692) + `adapters/src/auth/oauth/anthropic.ts`.
- Storage: the status bar shows the active store (`sqlite`/`pg`). `:db` shows it (`describeActiveDatabase`) or sets it — `:db pg <url>` / `:db sqlite [path]`, with a trailing `global` to write `~/.efferent/config.json` instead of the project `<cwd>/.efferent/config.json`; the store binds at boot, so a change applies on the next launch. `:settings` also reports the active store (Postgres password masked). Neither `dbUrl` is in `:set`.
- Observability deep-links: **`:traces`** opens the Grafana conversation dashboard filtered to the active session, **`:dashboard`** opens fleet-health (`actions/observability.ts` — reuses `browserCommand` + `Shell.exec`, the OAuth-login open-browser path; hints if telemetry export is off). Grafana base URL is `Settings.grafanaUrl` (default `http://localhost:3000`, set via `:set grafanaUrl <url>`). See the parent AGENT.md "Observability" section + `observability/README.md`.
