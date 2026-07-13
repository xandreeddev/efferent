---
title: Architecture
description: The package graph — foundry, engine, providers, surface, four agents, and the scenario packs — with one enforced dependency direction.
---

The repo is a small set of packages with **one enforced dependency direction**,
gated in CI by foundry's boundaries rule — an illegal import is a failing
finding, not a review comment.

```
packages/
├── foundry/      THE FIXED POINT — the factory: forge loop + static-analysis
│                 gates + the ratchet baseline machinery. Imports nothing internal.
├── engine/       the agent KERNEL (pure; effect + @effect/ai only): entities,
│                 ports, the loop, prompt mapping, the session chassis.
├── providers/    the EDGE: routed LanguageModel, SQLite conversation store,
│                 auth/settings, fs/shell, telemetry. providers → engine.
├── surface/      the UI substrate (pure): scoped themes, catalog component
│                 compiler, html template, sanitizer, validation boundaries.
├── smith/        the coder        → engine + providers + foundry
├── math/         the tutor        → engine + providers + surface
├── ui-agent/     typed page/component/theme agent + catalog ports → engine
├── surface/      trusted token/component compiler → ui-agent contracts
├── canvas/       host + SQLite page/catalog/theme adapters → agent + surface + providers
├── social/       the drafter      → engine + providers
└── scenarios/    evals — the TOP of the graph; may import agents;
                  nothing imports scenarios.
```

## The rules the gates enforce

Every package rides a **zero-entry ratchet baseline** — `bun run typecheck`
runs tsc plus the full gate suite, and any new violation anywhere fails:

- **Errors are values** — no `try`/`catch`/`throw`; typed errors are
  `Schema.TaggedError`; foreign promises cross via `Effect.tryPromise`.
- **State is a fold** — no `let`, no loop statements; `Effect.iterate`,
  `Effect.reduce`, array combinators, `Ref`.
- **Absence is `Option`**, union branching is `Match`, no `as any`
  laundering, entities carry branded id fields.
- **Tool failures are data** — toolkits use a shared `Failure` struct with
  `failureMode: "return"`, so the model corrects itself in the same run.
- **Ports are `Context.Tag` services** in the engine; adapters are one
  `<Thing>Live` Layer each in providers; composition happens at each agent's
  `main.ts` edge and nowhere else.

## History — the drop

The original runtime (an SDK + CLI + web app) was frozen, its learnings
re-authored into the packages above, and then deleted in one commit
(2026-07-07). What survived is the doctrine, not the code: the new line was
born under its own gates, with an empty baseline, and the audit numbers that
motivated the rewrite are recorded in [the factory's docs](/docs/concepts/foundry).
