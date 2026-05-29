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
```

## Hard rules
- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@agent/core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Http | Shell | LanguageModel | ConversationStore | SettingsStore>` (TUI adds `ModelRegistry` + `LlmInfo`) that subscribes to the agent's event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap providers, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants
- Six regions, top → bottom: **fixed hint bar** (1 row, tracks mode + focused pane), middle (scrollback ¦ optional side pane), separator, overlay (`:` command palette OR `/` search bar — mutually exclusive), input (1–8 visual rows, wrapped), separator, status bar. The input is always pinned at the bottom; scrolling never moves it.
- **Modal + multi-pane** (vim-flavoured, always on; no `editorMode` toggle). Three focusable panes — conversation / side / input — swapped with **Ctrl-h/j/k/l** in *any* mode (`uiMode.ts:moveFocus`); a swap only fires when a pane exists that way, so Ctrl-J/Ctrl-H still act as newline/backspace in the input (nothing is below/left of it). Entering the **input** pane → INSERT (type immediately); entering a read-only pane → NORMAL. Per-pane modes: **INSERT** only on the input pane; **NORMAL + VISUAL** on the read-only panes. Start: input focused, INSERT.
- **All key routing is a pure function** — `navKeys.ts:decideKey(ctx, key) → NavIntent` (no Effects, no mutation); the driver executes the intent. Unit-tested in `navKeys.test.ts` (`bun test`). Active-pane signal: a coloured `CHAT/SIDE/INPUT` badge in the hint bar + a bright focus gutter on the focused middle pane + the divider + the status-bar pane name.
- Keys (parsed in `keys.ts`): Backspace is `0x7f` and Enter is `0x0d` only, so `0x08`/`0x0a` surface as **Ctrl-H/Ctrl-J** (needed for pane focus); insert-mode Ctrl-H still acts as Backspace via `input.ts`.
- Conversation NORMAL nav (all on the `Scrollback`): j/k line, Ctrl-D/U half-page, PgUp/PgDn page (~75%, responsive), gg/G ends, {/} message hops. `/` opens search (highlights matches, n/N cycle); `:` opens the command palette. VISUAL (`v`): line-wise select, motions extend, `y` yanks the selection to the clipboard via **OSC 52** (`terminal.ts:osc52`), Esc cancels.
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
