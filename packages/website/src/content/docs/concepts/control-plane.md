---
title: Control plane & jobs
description: One entry unifies every way a turn starts — a human typing, a message queued while busy, a cron tick. A Job descriptor carries the source, the interaction policy, and the mission; scheduled jobs run headless behind a parking approval that never silent-allows.
sidebar:
  label: Control plane & jobs
  order: 9
---

A turn can start three ways: **you type** in the TUI, a message you sent **queued** while a turn was
running, or a **cron tick** fires a scheduled job at 2am. Those used to take three separate code paths
with subtly different setups — and the scheduled path was the dangerous one, because nobody is watching
it. The **control plane** collapses all three into one entry, so the rules are set in exactly one place.

## The `Job`

A `Job` is a small, pure routing descriptor — no IO, no `Schema` (it doesn't cross the wire; it's an
in-process descriptor):

```ts
// entities/Job.ts
export interface Job {
  readonly conversationId: ConversationId      // a scheduled fire makes a fresh one
  readonly folder: string                      // the scope the run is confined to
  readonly prompt: string                      // the task — and the run's `mission`
  readonly source: "interactive" | "queued" | "scheduled"
  readonly interactionPolicy: "interactive" | "headless"   // is a human watching?
  readonly agent?: string                      // optional ROLE for a scheduled job
  readonly title?: string                      // optional display label (e.g. in `:tree`)
}
```

The two fields that matter most are `source` (where the turn came from) and `interactionPolicy`
(whether a human is at the keyboard). Everything downstream — which primitive runs it, which approval
gates its tools, whether it knows the overall goal — follows from those.

## `JobController.submitJob` — the one router

The **`JobController`** (`workspace/inProcess.ts`) is the single entry. `submitJob` is a thin router
over the existing primitives; it does **not** rewrite them — it just applies a consistent policy:

| `source` | Routes to | Sets |
| --- | --- | --- |
| `interactive` | `send` (start/continue a turn) | `interactionPolicy: "interactive"` |
| `queued` | the between-turns queue, drained next | `interactionPolicy: "interactive"` |
| `scheduled` | `spawnAgent` | `mission = prompt` · `interactionPolicy: "headless"` |

The scheduled row is the whole point. A bare `spawnAgent` call (the old cron path) never seeded a
**mission** and never marked the run **unattended** — so a 2am job's sub-agents worked blind, and its
tools ran behind an allow-all approval. Routing through `submitJob` fixes both at once.

## `interactionPolicy` — interactive vs headless

`interactionPolicy` rides the [`RunContext`](/docs/concepts/runtime/) and is **inherited down the
subtree**, so every sub-agent a job spawns knows whether a human is present.

- **`interactive`** — your TUI turn. An approval the judge won't auto-clear opens the bash approval
  sheet and **parks the fiber** until you answer (`a`/`s`/`p`/`d`).
- **`headless`** — a scheduled, unattended run. There is nobody to park on, so the approval policy
  changes (below).

## Mission — the goal, inherited

A scheduled job seeds its `prompt` as the run's **`mission`** — the standing goal, carried down the
context tree the same way the interactive root seeds its mission for its sub-agents. So a leaf coder
three levels deep in a 2am run still knows *what the whole job is for*, instead of working from only its
narrow task. (This is the structural backstop described in [sub-agents](/docs/concepts/sub-agents/).)

## The parking approval — never silent-allow unattended

An unattended run can't open a modal and wait for a human. The old answer was `ApprovalAllowAllLive` —
which silently allowed **everything** a cron job tried, including reaching outside the workspace,
installing software, or touching the network. The **parking approval**
(`workspace/headlessApproval.ts`) closes that hole without ever blocking on an absent human:

1. It runs the **same fast-tier judge** + permitted-folder logic the interactive approval uses, so
   ordinary in-scope development work is still waved through silently.
2. For anything the judge would **not** auto-allow, it emits a `needs_human` event (`parked: true`)
   recording the need — tool, summary, reason, folder, session — and returns a **deny**, with a reason
   the model reads as an ordinary tool failure and adapts to in the same turn.

So it can only ever **deny more** than allow-all did — it never silently allows something the judge
wouldn't, and any judge failure (no key, bad JSON, a 429) degrades to **deny + record**, fail-closed,
the safe direction for an unattended run.

## The `needs_human` event — "decisions need you"

`needs_human` is a first-class [`AgentEvent`](/docs/concepts/runtime/), so it rides the ledger and
replays like any other:

```ts
// entities/AgentEvent.ts
{ type: "needs_human",
  sessionId?, nodeId?, tool?,
  summary: string, reason: string, folder?,
  parked: boolean }
```

`parked: true` marks a denied-but-recorded headless decision; an **interactive** approval also emits one
(`parked: false`) the moment it opens its sheet. The TUI gathers them into a **"decisions need you"**
roster (`cli/view/chrome/DecisionsBar.tsx`) — so whether you were watching or away, the things that
wanted a human surface in one place.

## The seams

| Concern | Where |
| --- | --- |
| The `Job` descriptor | `sdk-core/entities/Job.ts` |
| The `JobController` (`submitJob`) | `code/src/workspace/inProcess.ts` |
| Interaction policy on the run context | `sdk-core/usecases/runContext.ts` |
| The parking approval (headless) | `code/src/workspace/headlessApproval.ts` |
| Interactive (parking) approval | `code/src/workspace/serverApproval.ts` |
| The `needs_human` event | `sdk-core/entities/AgentEvent.ts` |
| The "decisions need you" roster | `code/src/cli/view/chrome/DecisionsBar.tsx` |
