---
title: The fleet
description: How a network of agents actually runs — fibers in one Effect runtime, a supervisor registry, an in-memory bus, a standing directive with a verifier, cron, and a headless scheduler daemon.
sidebar:
  label: The fleet
  order: 7
---

A **fleet** is a network of named agents that run together, coordinate, pursue a goal, and run
on a schedule. This page is the mental model and the wiring — the *how it works*. For the
hands-on walkthrough, see [Run a fleet](/docs/guides/fleet/).

The fleet is built on [sub-agents & the context tree](/docs/concepts/sub-agents/): a fleet
member is a sub-agent with an identity (a [role](/docs/guides/fleet/)),
an inbox, and a place in a supervisor's registry.

## The one mental model: fibers, not processes

**The whole fleet is a set of Effect fibers in one runtime — in-memory, same process. There are
no per-agent OS processes and no IPC.** This is the single most important thing to internalise,
because every other piece follows from it:

- An agent run is a **fiber** running the same `runAgentLoop`, sharing one `Layer` stack (the
  providers, stores, ports).
- Parallelism is `Effect.forEach` with bounded concurrency; write-safety is a `Semaphore`
  per folder; the shared spend pool is a `Ref<number>`; an agent's ambient identity is a
  `FiberRef` (`RunContext`).
- The comms bus is a couple of `Ref`s. Interrupting (`Esc`) tears the whole subtree down
  through structured concurrency — no orphans.

The durable record (the context tree, conversations) lives in SQLite; the *running computation*
is ephemeral fibers. Those two are orthogonal: a crash loses in-flight turns (we persist at turn
boundaries), never the history.

:::important[Why not a process per agent]
LLM agents are I/O-bound — they spend their life waiting on a provider — so fibers beat
processes handily, and the folder sandbox already gives write-safety: a sub-agent writes only
inside its folder, and same-folder writers serialize on a per-folder lock. Per-process isolation
would only cost us the elegant in-memory orchestration.
:::

## The supervisor

A fired agent runs **detached** — `forkIn` a long-lived runtime-owned scope — so it runs
*alongside* the conversation instead of blocking the turn. The **`FleetSupervisor`**
(`cli/state/fleet.ts`) is the in-memory registry of what's running right now: each live agent's
fiber handle (so `:stop` is `Fiber.interrupt`), its display title, and its folder. The
persistent `:tree` is the durable view; the supervisor is just the live handle set. The header's
`◆ N agents` chip reads the same live fleet via the event pump.

## Non-blocking by construction

Both spawn paths return without waiting on the work: a model's `run_agent` forks the child as a
supervised background fiber and hands back `{ nodeId, name, status: "running" }` at once; a human
`:spawn` fires a detached agent the same way. So a coordinator spawns its whole team in parallel and
never freezes — it gathers results with **`wait_for_agents`** (which parks only the caller, wakes on
a child finishing *or* a message *or* a timeout) and is reachable the entire time. The full message
protocol — channels, the on-the-wire shape, drain timing, completion routing, and the guarantees —
is its own page: **[agent messaging](/docs/concepts/agent-messaging/)**.

## The bus: mailboxes + a blackboard

Coordination is `Ref`-backed (`usecases/agentBus.ts`):

- **Mailboxes** — a per-agent inbox keyed by context-node id. `send_message` (or a human pairing in
  a preview) posts to one; the recipient's loop **drains it at its next turn boundary** (a driver
  `onTransformContext` hook) and folds the messages in as attributed `[inbox …]` user turns. A
  mailbox exists only while its agent is running (`markRunning` on spawn, `complete`/`markDone` on
  every exit), so a message to a finished agent fails fast.
- **Blackboard** — a shared scratchpad every agent in the turn's fleet reads and writes, so
  parallel siblings coordinate without addressing each other.
- **Completion + supervision** — the bus also holds each run's fiber (so `interruptAll` tears the
  fleet down on Esc/exit) and a completion latch; when a child finishes it posts the outcome to its
  parent's mailbox + the blackboard and keeps a terminal result for a later `snapshot`.

It's all in-process — no transport, no serialization.

## The seat

The supervisor tracks what's *running*; the **seat** is where *you* are — your keyboard attaches to
exactly one session at a time. Open a running node in `:tree` (`↵`) and your input routes to its
mailbox (the agent keeps running, reading at its next turn boundary); open a finished node and it
resumes in place; the lead conversation streams underneath the whole time, so detaching is free.
Foreground and background work are the same primitive — the only difference is where the seat sits.

## Roles and the toolkit subset

A role ([`.efferent/agents/*.md`](/docs/guides/fleet/)) is discovered
like skills (`loadAgents`), and selected by `run_agent`'s `agent` parameter. When a role runs,
three things change for that one fiber:

- **Prompt** — the role's body lands in the scope prompt's instructions slot, so the
  write-confinement and one-line return contract still wrap it.
- **Toolkit** — a *subset* built from the role's `tools` allowlist: both the toolkit (what the
  model sees) and a matching handler layer are projected from the same list, so they can never
  disagree. No allowlist ⇒ all base coding tools, but not `run_agent` (roles are leaf workers by
  default).
- **Model** — a role can pin a `model`. It rides the `RunContext` `FiberRef` as a
  `modelOverride`, which the [router](/docs/concepts/providers/) prefers over the session model
  for that fiber's main-tier calls only — helper tiers (fast, web search) are untouched.

## Extending: in code, not at runtime

Two doors, and the line is firm. **Compose with files** — roles, declarative tools, and skills
under `.efferent/` (read at startup, git-shareable) wire together capability efferent already has;
they carry no new logic. **Build in code** — a genuinely new capability is a typed `Tool.make` plus
an Effect handler in the source, gated by the type checker and the no-`try/catch` ban, loaded on the
next launch. efferent can write that code itself (it's a coding agent on its own tree), but it ships
like any code: nothing is hot-loaded, and there is no runtime `eval`. The payoff is that every
capability is reviewable, typed code — never an opaque blob injected mid-run.

## The directive and the verifier

A **directive** is a standing goal, injected into the agent's prompt every turn (so it rides the
whole session, not one message). The lead agent — directive in context, plus `run_agent` and the
bus — is the supervisor. Completion is judged by a separate **verifier**: a built-in, read-only
role spawned in a *fresh* context, so it never grades its own work (the lead-researcher pattern).
It returns `MET` / `NOT MET` / `INCONCLUSIVE` with evidence.

## Scheduling

Cron is a JSON job list (`~/.efferent/cron.json`) plus a per-minute tick that fires due jobs.
The cron matcher is self-contained (`usecases/schedule.ts` — 5 fields, with the
standard day-of-month / day-of-week OR semantics); a `minuteBucket` guard fires each match at
most once. The tick runs in the TUI runtime while it's up, and headless in `--mode daemon` — both
filter jobs to their own workspace `cwd`.

## Running headless

The agent loop is **identical** whether the fleet runs in your TUI or behind a daemon — only
*where the runtime lives* changes. `efferent --mode daemon` hosts the same runtime + scheduler with
no UI: it runs the per-minute cron tick forever, firing each workspace's due jobs as fresh agent
runs. The work persists to the same store, so you can open the TUI later and browse what ran in
`:tree` / `:sessions`. The print / json / rpc modes run the same loop too — one-shot or programmatic
(see [CLI & modes](/docs/reference/cli/)).

:::note[Durability is the record, re-driven]
efferent persists the **transcript** — every message lands in the store at run boundaries
(`ConversationStore.append` in `runAgent`; a sub-agent flushes its tail when the spawn finishes).
`:resume` reloads that history and **re-drives** the agent: the model re-derives from the record,
and file writes are already on disk. A crash loses only the turns in flight, never the history.
:::

## The seams

| Concern | Where |
| --- | --- |
| `run_agent`, fire (`spawnAgent`), the toolkit + role subset, comms handlers, the bus | `code/usecases/buildScopeRuntime.ts` |
| The comms bus (mailboxes + blackboard) | `code/usecases/agentBus.ts` |
| The live supervisor registry | `code/cli/state/fleet.ts` |
| Role / tool / directive / schedule definitions | `code/usecases/{loadAgents,loadTools,directive,schedule}.ts` |
| Ambient identity + per-role model override | `sdk-core/usecases/runContext.ts` → `adapters/llm/router.ts` |
| Shared token pool, folder locks | `sdk-core/usecases/tokenBudget.ts`, `code/usecases/folderLock.ts` |
| Persistent nodes | `sdk-core/ports/ContextTreeStore.ts` |
| The headless daemon | `code/modes/daemon.ts` |
