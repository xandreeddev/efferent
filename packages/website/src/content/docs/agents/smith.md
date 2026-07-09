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
status, each turn tagged with its model and token spend. The composer sits in
its own framed region — a rule above and below, hints and the model readout
on the footer line — with Tab-completion for `:` commands. Messages typed
while a turn runs are queued **in view** and drained into the next turn.
History scrolls (wheel / PgUp); a busy heartbeat ticks during long thinking
turns; Esc interrupts.

`:model` picks the general/code/fast roles, `:settings` opens the settings
menu, `:login` handles keys and the Anthropic OAuth flow, `:resume` replays
any past session from the persisted trail — reasoning, tools, and spend
included. After an accepted run, `:ship` branches, commits, pushes, and opens
the PR.

## The coder's harness

The implementor runs unattended with read/write/edit/Bash — and the harness
around it compounds across runs:

- **Sandboxed Bash** — every coder command runs inside bubblewrap: the
  workspace bind-mounted read-write, everything else read-only, a fresh
  `/tmp` and scratch `HOME`. Default ON (`--no-sandbox` opts out); the gates
  and `:ship` run unsandboxed — they are the human's own commands.
- **Workspace rules** — the first of `AGENTS.md` / `CLAUDE.md` /
  `.efferent/rules.md` reaches every brief, ahead of everything else.
- **Skills** — `.efferent/skills/<name>.md` files, disclosed progressively:
  names in the prompt, full instructions via `load_skill` on demand.
- **Memory** — after each run a curator distills durable workspace facts
  (conventions, build quirks, gotchas) into an append-only ledger; trusted
  facts reach the next brief, and facts confirmed across three runs graduate
  into `learned-<topic>` skills automatically.
- **MCP** — servers from `.efferent/config.json` surface as two tools
  (`mcp_describe` / `mcp_call`), so external capability costs a constant
  prompt overhead regardless of server size.
- **Compaction** — a run that outgrows 80k input tokens folds into a
  fast-tier handoff summary mid-attempt; gate rejections fold between
  attempts. Long runs stay in the model's healthy range.

## The judge comes last

After every deterministic rank is green, a **judge gate** (default ON; a spec
opts out with `judge: false`) asks the strong tier two questions the compiler
cannot: does the workspace actually fulfill the *intent*, and is the
implementation *honest* — real code, no stubs, no outputs shaped to game a
check, no weakened tests. Fail-closed: an unreachable judge or an
unparseable verdict is a failure, never a silent pass.

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
