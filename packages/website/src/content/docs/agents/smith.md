---
title: smith — the coder
description: The spec-driven agent in the factory — refine with a human, lock, forge under gates, all in a persistent workspace TUI.
---

smith is the coder at the forge. A rough idea becomes a **SpecDoc** — drafted
by a refiner agent, refined *with* the human, **locked** only by the human —
and only a locked spec forges: foundry's loop with the engine's direct coding
agent as the implementor and the gates as the judge. No fleet, no sub-agent
tree, no approval model: **refine is the prompt engineering, the gates are
the verdict, nothing in between**.

```bash
bun run smith --cwd <dir>            # the persistent workspace session (TTY)
bun run smith spec "<idea>" --cwd <dir>      # refine → :lock → :forge
bun run smith forge <slug> --cwd <dir> [-p]  # forge a LOCKED spec
bun run smith "<task>" --cwd <dir> [-p]      # shorthand: trivial locked spec + forge
```

## The workspace session

Bare `smith` on a TTY opens the workspace: a dashboard of specs, forge runs,
lessons from past failures, and resumable sessions — then refine ⇄ forge in
place. The conversation pane shows the full story live: what you said, what
the model **thought** (reasoning is first-class), every tool call with its
status, each turn tagged with its model and token spend, and a context-window
gauge in the status strip. History scrolls (wheel / PgUp); a busy heartbeat
ticks during long thinking turns; Esc interrupts.

`:model` picks the general/code/fast roles, `:login` handles keys and the
Anthropic OAuth flow, `:resume` replays any past session from the persisted
trail — reasoning, tools, and spend included.

## The spec is the contract

The SpecDoc lives at `<cwd>/.efferent/specs/<slug>.md` — git-committable
provenance. Its `## Checks` section (`name: command` pairs) becomes
rank-2 accept gates in the forge run: the acceptance criteria a machine can
verify **are** the definition of done. The refiner's system prompt says it
plainly: *a vague criterion cannot be enforced; a precise one becomes a gate.*

## The run is evidence

Every forge run writes `.foundry/runs/<id>.json` — each attempt, every gate
finding, and a reference to the implementor's persisted conversation. Exit
codes are honest: 0 accepted or locked, 1 rejected (a **result**, not an
error), 2 infrastructure.
