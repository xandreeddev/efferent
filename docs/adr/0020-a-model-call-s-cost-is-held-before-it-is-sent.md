# ADR 0020: A model call's cost is held before it is sent

- **Status:** accepted, 17 November 2026
- **Applies to:** `@xandreed/core/kernel` (the `ModelSpend` contract, `modelSpendMemory`, `modelSpendConformance`),
  `@xandreed/evals` (a run's spend ledger)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

An evaluation run can cap what its trials spend on models: a budget, shared by trials that run at once, and a run
that stops starting trials once a call is refused under it. The ledger that holds that budget was old core's
`ModelSpend`, charged by the old engine's models plugin, so the eval package depended on old core's root for it,
and the learn track's evals lessons loaded that root in the browser. The old engine is going. The ledger has to live
somewhere the eval package can reach without the sdk, and the kernel's own model providers have to be able to charge
it.

Three things had to be decided: where the contract lives, how much of the old one comes across, and whether it is a
store beside the journal.

## Decision

- **The contract is in core's kernel.** `ModelSpend` (`reserve`, `settle`, `release`, `totals`), its data, the
  ledger in memory and its kit sit in `@xandreed/core/kernel`, beside the journal's contracts. It is the one contract
  there that no turn needs. It sits there because the eval packages take it and nothing else of the framework, and
  must not depend on the sdk (root `AGENTS.md`). `./kernel` is granted to them for it.
- **A call's worst case is held before it is sent, and settled after.** Whoever sends a model call reserves the
  call's worst-case cost before it goes out, and is refused, with nothing held, when that would take the ledger past
  its cap. Once the call ends, the hold is settled at what the call cost, below or above the amount held, or
  released. A caller reserves uninterruptibly with what it does with the hold, so every hold is closed.
- **It has the total cap alone.** The old ledger also capped each turn, keyed by the old engine's run id, and kept a
  turn's entry until the turn was forgotten, which the old engine's turn did as its scope closed. Nothing in the
  kernel would forget a turn, so a ledger that capped turns would grow with every one; the eval package caps the run
  alone. A per-turn cap comes back with the provider that names a turn and forgets it, as a new key of `SpendCaps`.
- **It is no store beside the journal.** The journal is the only store of what an agent did and knows (ADR 0003).
  The ledger holds no conversation, and no part reads it to rebuild an agent. It cannot be a fold of the journal: a
  hold is taken before a call is sent, when nothing is stored yet, and must be able to refuse the call; the
  journal's records of what a call used are written after it. The two may disagree on a call that was cut short
  (its hold released or settled at what the provider billed, its answer never stored), and the ledger is the one
  that says what was spent.
- **A part that charges the ledger declares it.** A model provider that charges reserves through `ModelSpend` in
  its own type, so a stack that does not provide a ledger does not compile. No part looks for a ledger and sends
  uncapped without one: that is an optional contract a part uses when present, which the kernel's skill does not
  add. A host that wants no cap provides a ledger with none (`modelSpendMemory` with requests that name no cap).
- **The kernel calls no model, so it charges nothing itself.** Until a kernel provider charges the ledger, no
  first-party model call is held in it: an eval run's budget caps what its runnables reserve by hand. The old
  engine's models plugin charges old core's ledger, a separate service under its own key, until that engine goes.
  (Since 19 November 2026 the Node entry's providers charge it: ADR 0026.)

## Consequences

- The eval packages import `@xandreed/core/kernel` and not core's root, so the learn track's evals lessons no longer
  load the old engine in the browser.
- An eval run's `--budget-usd` caps nothing a first-party provider sends until the kernel's model providers charge
  the ledger. The release waits for them.
  - *Amended 19 November 2026 by
    [ADR 0026](0026-a-model-provider-charges-the-ledger-it-is-given.md):* the kernel's Node entry has two providers
    that charge it (`openAiCompatibleModel`, `anthropicModel`), so a run's budget caps what they send.
- The kit (`modelSpendConformance`) holds every ledger to the contract: reservations held under ids of their own,
  the cap, settlement, release, a repeat, reservations made at once, no cap. A shared ledger (a database, a
  service) passes the same checks.

## What would reopen this

A ledger that must outlive its process (spend shared between machines), which is a store and needs its own record; a
second cap with no turn to name; or a part that needs to know what was spent to decide what to do next (a model
choice by remaining budget), which would read the ledger, not only charge it.
