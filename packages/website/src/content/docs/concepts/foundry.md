---
title: Foundry — the factory
description: The forge loop, the gate pipeline, and the ratchet — the developer's real output is the system that produces code.
---

`@xandreed/foundry` is the factory: the idea that the developer's real output
is not code but **the system that produces code** — a spec, an implementor,
chained deterministic quality gates, typed feedback routed back into the
loop, and guardrails. It imports nothing internal; everything else may import
it.

## The forge loop

```
           ┌──────────────────────────────────────────────────┐
           │                    forge(spec)                   │
           │                                                  │
 spec ──▶  │  Implementor.implement ──▶ snapshot ──▶ pipeline │ ──▶ FactoryRun
           │        ▲                                  │      │     (artifact)
           │        └──── renderFeedback(report) ◀─────┘      │
           │              (typed findings → model brief)      │
           └──────────────────────────────────────────────────┘
              bounded by maxAttempts + wall-clock budget
```

One attempt: the implementor (any agent that satisfies the `Implementor`
port) writes into the workspace; foundry snapshots it; the **gate pipeline**
runs — ranked stages, fail-fast within a rank; every finding is a typed value
with a rule id, a location, and a message. A red report is rendered into the
next attempt's brief; a green report ends the run **accepted**. The run
artifact (`.foundry/runs/<id>.json`) records every attempt, every finding,
and a reference to the implementor's persisted conversation — the full
audit trail.

## The gates

Gates are pure static checks or command gates (a shell command whose exit
code is the verdict). The repo's own suite — the same one `bun run typecheck`
runs — enforces the Effect idioms: no `try`/`catch`, no `let`/loops, no
nullable returns, no tag switches, no `as any`, plus the boundaries rule that
pins the package graph.

## The ratchet

Legacy findings live in a committed **baseline** that may only shrink. A new
finding anywhere fails the build outright; fixing an old one and forgetting
to shrink the baseline also fails. The repo's baseline is **empty** — every
rule holds everywhere — and CI runs foundry's gates on foundry's own source.

## Lessons — deterministic memory

Accepted and rejected runs feed forward: the factory extracts per-rule
failure statistics from `FactoryRun` history and injects them into the next
refine session's context ("`effect/no-let` failed 2 attempts across 2 runs"),
so the spec and the brief get sharper without any model-side memory.
