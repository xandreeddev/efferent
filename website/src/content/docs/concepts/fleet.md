---
title: The fleet
description: How a network of agents actually runs — fibers in one Effect runtime, a supervisor registry, an in-memory bus, a standing directive, and a path to a headless daemon.
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
processes handily, and the folder sandbox already gives write-safety. Per-process isolation
would only cost us the elegant in-memory orchestration. The one real-isolation knob, optional
git-worktree scoping for same-repo parallel writers, is a sandbox detail, not a process model.
:::

## The supervisor

A fired agent runs **detached** — `forkIn` a long-lived runtime-owned scope — so it runs
*alongside* the conversation instead of blocking the turn. The **`FleetSupervisor`**
(`cli/state/fleet.ts`) is the in-memory registry of what's running right now: each live agent's
fiber handle (so `:stop` is `Fiber.interrupt`), its display title, and its folder. The
persistent `:tree` is the durable view; the supervisor is just the live handle set. The header's
`◆ N agents` chip reads the same live fleet via the event pump.

## The bus: mailboxes + a blackboard

Coordination is two channels, both `Ref`-backed (`usecases/agentBus.ts`):

- **Mailboxes** — a per-agent inbox keyed by context-node id. `send_message` posts to one; the
  recipient's loop **drains it at its next turn boundary** (a driver `onTransformContext` hook)
  and folds the messages in as attributed `[inbox …]` user turns. A mailbox exists only while
  its agent is running (`markRunning` on spawn, `markDone` on every exit), so a message to a
  finished agent fails fast.
- **Blackboard** — a shared scratchpad every agent in the turn's fleet reads and writes, so
  parallel siblings coordinate without addressing each other.

The human messaging a *running* agent uses the very same mailbox (the node-preview composer posts
to it). It's all in-process — no transport, no serialization.

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

## The directive and the verifier

A **directive** is a standing goal, injected into the agent's prompt every turn (so it rides the
whole session, not one message). The lead agent — directive in context, plus `run_agent` and the
bus — is the supervisor. Completion is judged by a separate **verifier**: a built-in, read-only
role spawned in a *fresh* context, so it never grades its own work (the lead-researcher pattern).
It returns `MET` / `NOT MET` / `INCONCLUSIVE` with evidence.

## Scheduling

Cron is the Hermes pattern: a JSON job list (`~/.efferent/cron.json`) plus a per-minute tick that
fires due jobs. The cron matcher is self-contained (`usecases/schedule.ts` — 5 fields, with the
standard day-of-month / day-of-week OR semantics); a `minuteBucket` guard fires each match at
most once. The tick runs in the TUI runtime while it's up, and headless in `--mode daemon` — both
filter jobs to their own workspace `cwd`.

## The execution model is staged

The agent loop is **identical** whether the fleet runs in your TUI or behind a daemon — only
*where the runtime lives* and *how the bus is transported* change:

- **Stage A — in-process** (today). One process, one runtime, in-memory bus. A live,
  message-into-able fleet. Agents die when the client exits; state persists.
- **Stage B — daemon** (the platform end-state). A long-lived `efferent daemon` hosts the
  runtime + supervisor + scheduler; TUI / CLI / web attach as clients over the existing
  `rpc` / `json` protocol extended with `fleet.spawn` / `send` / `list` / `subscribe`. Agents are
  *still fibers*; the bus just fans over a socket. `modes/daemon.ts` is the seam — today it runs
  the scheduler headless; the attach protocol is the deferred remainder.

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

## Deferred

Each piece ships a real v1 with an honest remainder: **MCP** server refs (a larger client; the
declarative format covers tool-sharing), an **autonomous supervisor loop** and **persisting the
directive across resume**, a **live reactive cockpit pane** (`:fleet` is today's snapshot), a
**model-facing `schedule` tool** (human-driven for now), and the full **Stage B attach protocol**.
The substrate — fibers, the supervisor, the bus, the context tree — is what the rest hangs off.
