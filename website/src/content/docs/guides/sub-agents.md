---
title: Spawning sub-agents
description: How the run_agent tool delegates work to folder-scoped sub-agents, and how to pick a seed mode.
sidebar:
  label: Sub-agents
  order: 6
---

Delegation is one tool — `run_agent` — backed by a [persistent context
tree](/docs/concepts/sub-agents/). It ships in the coding agent's toolkit (`buildScopeRuntime`); any
agent built on a scope runtime gets it. This guide is about *using* it well.

## The call

```
run_agent({ name, folder, task, seedFromNode?, seedMode? })
```

- **`name`** (2–5 words) — the sub-agent's display title everywhere.
- **`folder`** — the scope its writes and bash are confined to.
- **`task`** — what to do.
- **`seedFromNode` + `seedMode`** — how to seed context from an existing node (omit for a fresh spawn).

It returns `{ summary, filesChanged, nodeId }`. A failed spawn is returned as data, not a thrown turn.

## Choosing a seed mode

The routing policy lives in the tool description and the system prompt; the short version:

| Mode | What it does | When |
| --- | --- | --- |
| *(fresh)* | New node, just the task. | **Default.** One agent = one piece of work. |
| `resume` | Continue *in* an existing node (full history each turn). | A direct follow-up to that exact work. |
| `branch` | Child node seeded from the source's **verbatim** messages. | Explore an alternative from a known state. |
| `handoff` | Child seeded with a **generated brief** of the source's work. | **Preferred follow-up** — continuity at a fraction of the tokens. |

The principle: *one agent = one piece of work, fresh by default, reuse only for direct follow-ups, the
cheapest sufficient seed.*

## What keeps it safe

- **Depth** is capped (`maxDepth`, default 2); **steps** per run are capped (`subAgentMaxSteps`).
- A **shared token budget** (`subAgentTokenBudget`, default 1M) is drawn down across the whole subtree;
  exhaustion refuses new spawns and stops running ones at a turn boundary, marking partial results partial.
- **Disjoint folders run in parallel**, write-safe by construction; same-folder spawns serialize on a
  per-folder lock; Esc interrupts the whole subtree (structured concurrency, no orphans).
- Resuming against a moved git HEAD prepends a **staleness brief** so the sub-agent re-reads before editing.

Tune the bounds with `:set subAgentTokenBudget <n>` / `:set subAgentMaxSteps <n>`, or the corresponding
[settings](/docs/reference/settings/).
