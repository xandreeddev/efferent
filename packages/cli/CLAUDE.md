# @agent/cli

Coding-agent driver — composition root for four modes, plus a hand-rolled TUI.

## Layout

```
packages/cli/src/
├── main.ts            @effect/cli command + Layer composition + mode dispatch
├── events.ts          AgentEvent union + makeEventHooks(queue, beforeToolHook)
├── safetyHooks.ts     bashConfirmHook / denyBashHook
├── modes/
│   ├── tui.ts         full-screen TUI driver (TTY default)
│   ├── print.ts       one-shot, streams final text to stdout
│   ├── json.ts        same loop as print but JSONL events on stdout
│   └── rpc.ts         bidirectional JSON-RPC over stdio
└── tui/
    ├── terminal.ts    raw mode, ANSI escapes, alt buffer, getTermSize
    ├── keys.ts        stdin byte → discriminated Key event parser
    ├── render.ts      diffing frame composer (status + scrollback + palette + input + modal)
    ├── statusBar.ts   model + token gauge + cwd
    ├── scrollback.ts  user / assistant / tool / info / error blocks
    ├── input.ts       multi-line editor (Enter/Ctrl-J newline in INSERT; submit from NORMAL via Enter)
    ├── slashPalette.ts /<cmd> autocomplete overlay
    ├── modal.ts       generic centered y/n confirm
    └── markdown.ts    minimal markdown → ANSI converter
```

## Rules

- No domain logic. If something looks like a decision about *what* the agent does (vs *how* it's invoked from a terminal), it belongs in `@agent/core`.
- Each mode is a single `Effect.Effect<void, never, FileSystem | Shell | Llm | ConversationStore>` that subscribes to the agent's event queue and renders its way.
- `main.ts` is the *only* place adapter selection happens. To swap the LLM provider, swap the Layer imported here.
- Mode resolution defaults: argv prompt or piped stdin → print; TTY → tui; else print. `--mode <x>` overrides.
- `--help` and `--version` are provided by `@effect/cli` — don't shadow them.

## TUI invariants

- **Modal + multi-pane** (vim-flavoured). Regions top→bottom: fixed hint bar, middle (scrollback ¦ side pane), separator, overlay (`:` palette OR `/` search), input, separator, status. Input is pinned at the bottom.
- Three focusable panes (conversation / side / input) swapped with **Ctrl-h/j/k/l**. INSERT only on the input; NORMAL + VISUAL on the read-only panes. NORMAL: j/k · Ctrl-D/U · PgUp/PgDn · gg/G · {/} scroll, `/` search (n/N), `:` commands. VISUAL: `v` select, `y` yanks to clipboard (OSC 52). No mouse tracking — native click-drag selection still works. See `SCOPE.md` for the full spec.
- Renders are full-frame composed then line-diffed against the previous frame to avoid flicker.
- Raw mode + alt buffer + bracketed-paste; restored on exit (Ctrl-C, `:exit`, signal).
- Bash safety: `bashConfirmHook` opens the modal and blocks the model's call with `{ action: "block", reason }` on `n`/Esc. The hook is wired only in tui mode; non-interactive modes use `denyBashHook(--allow-bash)`.

## Hardcoded knobs (move to a settings layer later)

- Bash timeout default (in `coderAgentConfig` tools): 60s.
- TUI palette: 6 visible rows, `:` commands hardcoded in `slashPalette.ts`.
- maxSteps for the agent loop: 5 (in `runAgentLoop`).
