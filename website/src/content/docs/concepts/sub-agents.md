---
title: Sub-agents & the context tree
description: One generic run_agent tool spawns folder-scoped sub-agents over a persistent branching context tree — resume, branch, or hand off.
sidebar:
  label: Sub-agents
  order: 6
---

Delegation in efferent is **one generic tool over a persistent branching context tree** — not pre-wired
per-scope tools, not special prompt instructions.

## `run_agent`

```
run_agent({ name, folder, task, seedFromNode?, seedMode?, agent? })
```

Spawns a sub-agent scoped to `folder` — its writes and bash are confined there by the sandbox — and runs
it in the **background**, returning `{ nodeId, name, status: "running" }` to the parent **immediately**:
the spawner never blocks on the subtree. The result is collected later with `wait_for_agents` (or arrives
in the parent's inbox when the child finishes) — see [agent messaging](/docs/concepts/agent-messaging/).
`failureMode: "return"` means a failed spawn is data, not a dead turn. The toolkit is **static**: the same
tools at every depth, so sub-agents can spawn sub-agents.

## Every spawn persists

Each spawn is an `AgentContextNode` in the `ContextTreeStore` — `{ parentId, folder, edgeKind, seed,
status, returnSummary, filesChanged, usage, … }`. The node's full message history persists; the `seed`
column is a small descriptor (`task` | `selection` | `handoff`). That tree is what lets you **resume**,
**branch**, or **hand off** later:

- **resume** — append the task to an existing node and continue in its context (full history every turn).
- **branch** — spawn a child seeded from the source node's verbatim messages.
- **handoff** (the preferred follow-up) — spawn a child seeded with a *generated brief* of the source's
  work: continuity at a fraction of the tokens.

## Bounds: depth, budget, locks

- **Depth** — a `maxDepth` guard (default 2) returns `MaxDepthReached` as a tool failure. Each run is also
  bounded by its own step cap (`subAgentMaxSteps`, default 80).
- **Token budget** — a single shared pool (`subAgentTokenBudget`, default 1M, `0` = off) is drawn down by
  every sub-agent in a turn's subtree; a drained pool refuses new spawns (`BudgetExhausted`) and stops
  running ones at their next turn boundary, stamping partial results as partial.
- **Parallelism** — spawning is non-blocking, so multiple `run_agent` calls in one turn each fork-and-return
  at once and the whole fleet runs in parallel. Disjoint folders are write-safe by construction; same-folder
  spawns serialize on a per-folder lock. Since the fleet are background fibers, Esc interrupts the root *and*
  the whole fleet (`bus.interruptAll`), and a runtime finalizer does the same on exit — no orphans.

## Ambient folder context

`SCOPE.md` in a folder is **ambient context, not an agent definition**: its body is injected into any
sub-agent scoped there. Nodes are also stamped with the workspace git HEAD at finish, so resuming against
a moved HEAD prepends a **staleness brief** (the ref range + a scoped `git diff --stat` + "re-read before
editing"). All best-effort: non-git workspaces never stamp, a GC'd ref never breaks a spawn.

Identity flows ambiently through a `FiberRef` (`RunContext`: root conversation, parent node, depth, token
pool, compression policy), re-seeded for each child — so spawning is one tool call, not manual plumbing.
