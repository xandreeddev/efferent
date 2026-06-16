# @efferent/cli

Coding-agent driver — composition root for four modes, plus the OpenTUI/SolidJS TUI.

## Layout

```
packages/cli/src/
├── main.ts            @effect/cli command + Layer composition + mode dispatch
├── events.ts          AgentEvent union + makeEventHooks(queue, extraBeforeTool?)
├── terminal.ts        OSC-52 + spinner-frame + ANSI/width helpers (shared infra; print mode uses it too)
├── modes/
│   ├── tui.ts         just the TuiModeInput seam (driver moved to tui-solid/)
│   ├── print.ts       one-shot, streams final text to stdout
│   ├── json.ts        same loop as print but JSONL events on stdout
│   └── rpc.ts         bidirectional JSON-RPC over stdio
├── tui-solid/         the TUI driver — OpenTUI native renderer + SolidJS (no React)
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

- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@efferent/core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Shell | Llm | ConversationStore>` that subscribes to the agent's event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap the LLM provider, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants

- **Modal + multi-pane**, rendered by OpenTUI (Yoga/flexbox `<box>`/`<text>`/`<scrollbox>`/`<textarea>`, plus native `<markdown>` for assistant prose and `<diff>` for `edit_file` diffs, both **tree-sitter syntax-highlighted** for fenced code + hunks — `view/syntax.ts` holds the combined `SyntaxStyle` + the best-effort `getTreeSitterClient()` accessor (worker destroyed by `runtime.ts` on exit); grammars ship with `@opentui/core` (JS/TS/markdown/zig) and `web-tree-sitter` is a declared runtime dep), not hand-drawn. Regions top→bottom: middle (**two bordered boxes** — conversation and side — with **one empty column between them**, `App.tsx` flex row + `gap`), the **bordered keybind box**, a `:` palette OR `/` search-status line, the input box, status bar, dim footer. Modal overlays (`:model`/`:login`/`:settings`/…) float over everything via an absolutely-positioned `zIndex` layer.
- **Per-pane accent colours.** The focused box's border + title brighten to that pane's accent: **conversation = cyan, side = magenta, input = green** (unfocused = gray). `tokens.accent` + `paneBorder()` (in `presentation/theme/`; no `PANE_ACCENT`/`render.ts` anymore), applied via the `<Pane>` primitive (`view/ui/`). The keybind box's border + title use the **focused** pane's accent, title carries `<pane> · <MODE>` (the status bar is `model · tokens · storage · cwd`).
- Three focusable panes (conversation / side / input) swapped with **Ctrl-h/j/k/l or Ctrl-arrows**. The input is INSERT, the read-only panes NORMAL with a **vim-style fold cursor** over `presentation/paneNav.ts` rows (`{}`/`[]` paragraph/message, `gg`/`G` ends, `⇥`/`↵`/`h`/`l` fold the unit under it — **charwise `w/b/e` + VISUAL still deferred**; see `docs/roadmap.md`). Conversation NORMAL: j/k·↑↓ **scroll lines** · Ctrl-D/U half · PgUp/PgDn · the fold cursor (`{}`/`[]`/`gg`/`G`) tints + scrolls the current unit in · `⇥`/`↵`/`h`/`l` fold it · `Z` fold-all · `/` search (n/N · Esc) · `y` yank. Side pane (Activity + context): j/k·`{}` move · `[]` head · gg/G ends · Tab/Enter/h/l·←→ fold; context-viewer adds Space pick + `b` build. **`/` searches the focused pane** (seed via `/`-in-pane). `:` commands, `z` zoom, `Ctrl-C` 2×-to-quit.
- **Selection/yank uses OpenTUI's native mouse** (`useMouse:true`): drag-select highlights, `y` (read-only panes) copies the selection via OSC 52 (`renderer.copyToClipboardOSC52`). The input `<textarea>` owns its own selection/edit while typing.
- The **keybind box** is **two labelled rows** (`view/chrome/Keybinds.tsx`): a dim global **`nav`** row over a dynamic row of the focused pane's real keys.
- The renderer (alt buffer / raw mode / mouse / frame loop) is OpenTUI's, wrapped in an `Effect.acquireRelease` so the terminal is restored on success, failure, AND interruption.
- Bash safety: non-interactive modes gate on `--allow-bash` (the `allowBash` flag flows into `codingToolkitLayer`; a denied call returns to the model as a tool failure). The TUI passes `allowBash:true`; a per-command approval modal consulted from `onBeforeToolCall` is **not yet wired** (see `docs/roadmap.md`).

## Hardcoded knobs (move to a settings layer later)

- Bash timeout default (in `coderAgentConfig` tools): 60s.
- TUI palette: 6 visible rows, `:` commands hardcoded in `slashPalette.ts`.
- maxSteps for the agent loop: default 20 (`Settings.maxSteps`; `runAgentLoop` falls back to 20).
- Conversation store: SQLite at `~/.efferent/efferent.db` by default; `EFFERENT_DB_URL` (a `postgres://…` URL → Postgres, any other value → SQLite at that path) or a `dbUrl` in `~/.efferent/config.json` selects otherwise — env wins, config is seeded into the env at boot (`seedDbUrlFromConfig` in `main.ts`; `parseDbTarget`/`ConversationStoreLive` in `adapters/src/database/migrator.ts`).
- Setup / credentials: there is **no first-run wizard and no `init`** — `efferent` always boots into the TUI and you add a provider in-session with **`:login`** (`loginFlow.ts`: *Use a subscription*/OAuth or *Use an API key* → provider → masked key or browser OAuth). Credentials live only in `~/.efferent/auth.json` via the `AuthStore` port; **no env-var key reading**. The router resolves the key per turn, so a login takes effect immediately (no restart). `:logout <provider>` removes one. With no credential the TUI shows a `:login` warning and the send-gate short-circuits; non-interactive modes exit with the same hint. OAuth subscription (Anthropic) uses `login/oauthServer.ts` (callback on :53692) + `adapters/src/auth/oauth/anthropic.ts`.
- Storage: the status bar shows the active store (`sqlite`/`pg`). `:db` shows it (`describeActiveDatabase`) or sets it — `:db pg <url>` / `:db sqlite [path]`, with a trailing `global` to write `~/.efferent/config.json` instead of the project `<cwd>/.efferent/config.json`; the store binds at boot, so a change applies on the next launch. `:settings` also reports the active store (Postgres password masked). Neither `dbUrl` is in `:set`.
- Observability deep-links: **`:traces`** opens the Grafana conversation dashboard filtered to the active session, **`:dashboard`** opens fleet-health (`actions/observability.ts` — reuses `browserCommand` + `Shell.exec`, the OAuth-login open-browser path; hints if telemetry export is off). Grafana base URL is `Settings.grafanaUrl` (default `http://localhost:3000`, set via `:set grafanaUrl <url>`). See the parent AGENT.md "Observability" section + `observability/README.md`.
