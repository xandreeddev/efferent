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
└── tui/{terminal,keys,render,statusBar,scrollback,input,slashPalette,modal,markdown,logger,sidePane,viMode}.ts
```

## Hard rules
- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@agent/core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Shell | Llm | LlmCache | ConversationStore>` (TUI adds `LlmInfo`) that subscribes to the agent's event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap providers, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants
- Five regions, top → bottom: middle (scrollback ¦ optional side pane), separator, palette (when `/` is typed), input (1–8 visual rows, wrapped), separator, status bar.
- Side pane shows the live agent stack (parent + any in-flight sub-agent + its current tool), skills loaded this session via `read_skill`, and AGENT.md files discovered at startup. Hidden under 60 cols.
- Sub-agent inner tool calls do NOT push pills to scrollback — they update the side pane's top frame's `currentTool`. The parent's `delegate_to_<name>` pill stays in the scrollback.
- Input wraps at terminal width; PgUp/PgDn scroll the conversation; cursor walks visual rows.
- Editor mode is `insert` by default; `/set editorMode vi` enables vi-lite (insert/normal + hjkl/w/b/e/0/$/gg/G/i/a/o/x/dd/dw/u). Status bar shows `INS`/`NOR` only when vi is active.
- Renders are full-frame composed then line-diffed against the previous frame to avoid flicker.
- Raw mode + alt buffer + bracketed-paste; restored on exit (Ctrl-C, Ctrl-D, `/exit`, signal).
- Bash safety: `bashConfirmHook` opens the modal and blocks the model's call with `{ action: "block", reason }` on `n`/Esc. The hook is wired only in tui mode; non-interactive modes use `denyBashHook(--allow-bash)`.

## Hardcoded knobs (move to a settings layer later)
- Bash timeout default: 60s.
- TUI palette: 6 visible rows; slash commands hardcoded in `slashPalette.ts`.
- `maxSteps` for the agent loop: 20.
