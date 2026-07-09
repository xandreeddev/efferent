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

A gate is a **value** — `{name, kind, deterministic, run}` — and a pipeline
is data. Kinds rank by cost: `static` (0) → `typecheck` (1) → `test` (2) →
`eval` (3) → `judge` (4). The staged policy runs everything **within** a rank
(maximize feedback per expensive attempt) and fails fast **across** ranks —
never run tests on code that doesn't typecheck, never spend judge tokens on
code that fails the AST rules. A gate that cannot *run* folds to a failure
carrying a `gate-crashed` finding: **fail-closed, never a silent pass**.

The deterministic ranks are pure static checks over one shared `ts.Program`
(the Effect idioms: no `try`/`catch`, no `let`/loops, no nullable returns, no
tag switches, no `as any`; plus the boundaries rule that pins the package
graph) and command gates — a shell command whose exit code is the verdict.

Rank 4 is the **judge**: an LLM gate that runs last, judges only what
determinism cannot (intent fulfillment, honesty of the implementation), and
is marked non-deterministic on its verdict. In smith it's ON by default and
fail-closed — an unparseable verdict is a failure. A **red-first probe**
warns when a spec's accept check already passes on the untouched workspace:
a check that is green before any work cannot measure the work.

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
