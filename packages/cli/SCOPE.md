---
name: cli
description: Owns packages/cli/. Coding-agent driver — composition root + four modes (TUI, print, json, rpc) + hand-rolled TUI primitives on Bun + ANSI. No React/Ink/blessed.
---

## Layout
```
src/
├── main.ts            @effect/cli command + Layer composition + mode dispatch
├── events.ts          AgentEvent union + makeEventHooks(queue, beforeToolHook)
├── safetyHooks.ts     bashConfirmHook / denyBashHook
├── modes/{tui,print,json,rpc}.ts
└── tui/{terminal,keys,render,header,uiMode,navKeys,statusBar,scrollback,input,slashPalette,modal,markdown,logger,sidePane,viMode}.ts
skills/                bundled (internal) base skills shipped with the agent — *.md + sidecar scripts
```

## Bundled skills
- `skills/` holds the **internal** base skills shipped with the binary (currently `web-search.md` + `web-search.js`). `main.ts` resolves this dir off `import.meta.url` (→ `packages/cli/skills`) and passes it to `loadSkills(cwd, home, internalDir)` as the lowest-priority source, so a workspace `.agent/skills/<name>.md` shadows a built-in of the same name. Skills carry `internal: boolean`; the prompt tags built-ins `(built-in)`.
- A script-backed skill references its sidecar via the `{{SKILL_DIR}}` token (substituted by `read_skill` with the `.md`'s absolute dir), so `bash {{SKILL_DIR}}/web-search.js "<q>"` works from any cwd. The `web-search` skill is the **optional Brave engine** (needs `BRAVE_API_KEY` + bash); the key-free default is the native `web_search` tool (provider-native grounding via `WebSearchLive`). This is domain config, not logic — the loader/substitution live in `@agent/core`.

## Hard rules
- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@agent/core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Http | Shell | LanguageModel | ConversationStore | SettingsStore | WebSearch>` (TUI adds `ModelRegistry` + `LlmInfo`) that subscribes to the agent's event queue and renders its way. (`WebSearch` is required because the coding toolkit's `web_search` handler resolves it.)
- `main.ts` is the *only* place adapter selection happens. To swap providers, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants
- Regions, top → bottom: **fixed hint bar** (1 row, tracks mode + focused pane), a **pinned pane-title row** (`conversation` / `context`, focused one highlighted), middle (scrollback ¦ optional side pane), separator, `:` command palette (when open), **input** (1–8 rows; pinned at the bottom — scrolling never moves it), separator, status bar.
- The input is a vim-style **command line**: its prompt morphs with `entry` — `❯` message · `:` command · `/` search (`input.ts:PROMPTS`). `:`/`/` open from NORMAL, or from INSERT on an empty buffer (so they stay literal mid-message); the body is typed in the input (no prefix char). Search shows a right-aligned `i/total` count on the input row; there is **no separate search bar**.
- **Submit is a NORMAL-mode action.** In INSERT, Enter (and Ctrl-J) insert a **newline** — composing never submits. You send a message by leaving INSERT (`Esc`) and pressing **Enter in NORMAL** (`viMode.ts` handles NORMAL Enter→submit; `input.ts`'s Enter case is newline-only and is the INSERT path). Empty input doesn't submit. (`:`/`/` Enter still run/jump via the command-line `entrySubmit`.)
- **Persistent cursor** (the single "where am I" anchor): the conversation pane carries a `cursorLine` present in NORMAL *and* VISUAL (`scrollback.ts`). It renders as a bright-**yellow** gutter `▶` caret (dim when unfocused — a `/` search still shows where Enter lands) + a dim full-row tint (`terminal.ts:bgCursorLine`). Neither pane draws a focus bar (a bar flush against content reads as overlapping it). The conversation has a **2-col gutter** (`▶ ` caret + space on the cursor row, two blanks elsewhere) so the caret never abuts the text (`▶ 29.`, not `▶29.`) and every row gets a small left margin; the side gutter is a single blank. Pane focus is shown by the highlighted pane title + the badge + the bright divider (and, on the conversation, the caret + row tint). `cursorLine` is the source of truth — every motion moves it and the viewport follows with a scrolloff margin (`followCursor`); `scrollOffset` is derived. Conversation NORMAL nav (all move the cursor): j/k line, Ctrl-D/U half-page, PgUp/PgDn page (~75%), gg/G ends, {/} message hops. `:` opens the command line + palette.
- **Follow-tail**: a cursor on the last line rides new streaming output to the bottom; a cursor parked up in history is *not* yanked down by appends (`render()` snapshots `wasAtTail` before re-flatten, and bumps the offset by the growth otherwise). `submit()` re-engages the tail (`cursorToBottom`). `initCursor()` (called on focus-in) parks a never-placed cursor at the newest line; a placed cursor persists across focus changes.
- **Search returns to the conversation**: `/` is typed in the input line, but on Enter focus lands on the **conversation pane** (NORMAL) with the cursor on the match — `n/N` then move the cursor between matches. Esc clears the highlight and returns to whichever pane opened the search (`preSearchFocus`). The conversation caret stays visible (dim) while you type the query.
- **Zoom** (`z` in NORMAL on a read-only pane, `uiMode.ts` focus unaffected): maximizes the focused pane to fill the whole middle region (other pane + divider hidden) for distraction-free reading; `z` or Esc exits, and swapping focus / opening the command line auto-exits (you can never be zoomed on a hidden or input pane). Header / input / status / title rows stay; only the middle collapses. (`Ctrl-w` is intentionally unused — it'd need a chord state machine; single-key `z` is collision-free.)
- **Modal + multi-pane** (vim-flavoured, always on; no `editorMode` toggle). Three focusable panes — conversation / side / input — swapped with **Ctrl-h/j/k/l** in *any* mode (`uiMode.ts:moveFocus`); a swap only fires when a pane exists that way, so Ctrl-J/Ctrl-H still act as newline/backspace in the input (nothing is below/left of it). Entering the **input** pane → INSERT (type immediately); entering a read-only pane → NORMAL. Per-pane modes: **INSERT** only on the input pane; **NORMAL + VISUAL** on the read-only panes. Start: input focused, INSERT.
- **All key routing is a pure function** — `navKeys.ts:decideKey(ctx, key) → NavIntent` (no Effects, no mutation); the driver executes the intent. Unit-tested in `navKeys.test.ts` (`bun test`). Active-pane signal: a black-on-bright-cyan `CHAT/SIDE/INPUT` badge in the hint bar + the highlighted pane title + the divider + the status-bar pane name.
- **Block styling** (`scrollback.ts:renderBlock`): a **user** turn gets a bright-green left accent bar `┃` down the whole block (no fill); an **assistant** turn a cyan `●`; a **reasoning** block (the model's externalised thinking, surfaced from the response's reasoning parts via `assistant_message.reasoning`) renders dim+italic with a quiet `✻`, capped to ~4 lines until Ctrl-R. The model is nudged (coder prompt) to write a one-line intent before tool calls, and the loop emits `onAssistantMessage` *before* that step's tool events so narration/reasoning renders above its tool pills. `edit_file` diffs use coloured +/- text with **no filled background**. Badges are black-on-bright (`terminal.ts:bgBright*`) for contrast.
- Keys (parsed in `keys.ts`): Backspace is `0x7f` and Enter is `0x0d` only, so `0x08`/`0x0a` surface as **Ctrl-H/Ctrl-J** (needed for pane focus); insert-mode Ctrl-H still acts as Backspace via `input.ts`.
- VISUAL (`v`, conversation pane): a line-wise selection anchored at the **current cursor** (not the viewport top); the same cursor motions extend it (`startVisual` sets the anchor, `selRange` reads anchor+cursor), `y` yanks the selection to the clipboard via **OSC 52** (`terminal.ts:osc52`), Esc/`v` cancel.
- **No mouse tracking** is enabled — the TUI stays out of mouse-reporting mode so terminal-native click-drag selection keeps working; copying is also available keyboard-side via VISUAL + `y`.
- `Scrollback` memoizes per-block wrapped lines (keyed by block identity + cols + expanded) so a keystroke/spinner tick re-flattens cached arrays instead of re-wrapping. Above/below "↑ N above" / "↓ N below" indicators are independent (top and bottom rows).
- Side pane shows the live agent stack (parent + any in-flight sub-agent + its current tool), skills loaded this session via `read_skill`, and AGENT.md files discovered at startup. Hidden under 60 cols. The divider leans bright toward the focused side.
- Sub-agent inner tool calls do NOT push pills to scrollback — they update the side pane's top frame's `currentTool`. The parent's `delegate_to_<name>` pill stays in the scrollback.
- Renders are full-frame composed then line-diffed against the previous frame to avoid flicker.
- Raw mode + alt buffer + bracketed-paste; restored on exit (Ctrl-C, `:exit`, signal).
- Bash safety: `bashConfirmHook` opens the modal and blocks the model's call with `{ action: "block", reason }` on `n`/Esc. The hook is wired only in tui mode; non-interactive modes use `denyBashHook(--allow-bash)`.

## Hardcoded knobs (move to a settings layer later)
- Bash timeout default: 60s.
- TUI palette: 6 visible rows; `:` commands hardcoded in `slashPalette.ts`. Hint bar: 1 row. Wheel tick / page step live in `scrollback.ts`.
- `maxSteps` for the agent loop: 20.
