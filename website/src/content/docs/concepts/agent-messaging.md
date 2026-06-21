---
title: Agent messaging
description: The protocol agents (and you) use to talk — mailboxes drained at turn boundaries, a shared blackboard, non-blocking spawn + gather, and how it's verified. An in-process analog of A2A, not the wire protocol.
sidebar:
  label: Agent messaging
  order: 7
---

efferent's fleet is a **team, not a blocking call tree**: an agent spawns helpers that run in the
background, talks to them while they work, and gathers their results without freezing. This page is
the protocol that makes that true — the channels, the message shapes, the delivery timing, and the
guarantees. It builds on [sub-agents & the context tree](/docs/concepts/sub-agents/) and
[the fleet](/docs/concepts/fleet/); here we zoom in on *how the messages move*.

Everything is **in one Effect runtime — fibers and `Ref`s, no IPC**. The bus is
`code/usecases/agentBus.ts` (`AgentBus`).

## Three channels

| Channel | Shape | Who reads it | When |
| --- | --- | --- | --- |
| **Mailbox** | `InboxMessage { from, content, at }` per agent, keyed by node id | the addressed agent | drained at its next turn boundary |
| **Blackboard** | `BoardNote { from, note, at }`, one shared list | any agent, via `blackboard_read` | on demand |
| **Completion** | the bus posts a finish line to the **parent's** mailbox + the blackboard | the parent | when a child finishes |

A mailbox exists **only while its agent is running** — `markRunning` on spawn, `markDone`/`complete`
on every exit. The root conversation registers one too, under its `conversationId`, so *you* are
reachable mid-turn (see [the seat](/docs/concepts/fleet/#the-seat)). Posting to a finished agent
fails fast (`AgentNotRunning`) — its result is in the context tree, so you resume it instead.

## The message on the wire

There is no envelope and no serialization — a "message" is a small record folded into the
recipient's LLM context as an attributed user turn:

```
[inbox · message from backend]
the /users endpoint now returns { id, name } — build against that
```

That's it. `inboxToMessages` renders each drained `InboxMessage` into exactly that shape. The
recipient's model reads it as input from the outside, not as its own prior thought. Because it's
just context, **any agent can act on any message** — there's no schema to satisfy, no capability
negotiation.

## Delivery: at the turn boundary, all at once, exactly once

The question that matters: *when does an agent take its pending messages?* **At the start of every
turn — never mid-tool-call, never "at the end of the loop."** The loop calls its
`onTransformContext` hook before building each turn's prompt
([`agentLoop.ts`](/docs/concepts/agent-loop/)); the root and every sub-agent install the same hook:

```ts
onTransformContext: (messages) =>
  Effect.gen(function* () {
    const inbox = yield* bus.drain(myNodeId)         // takes ALL pending, atomically
    return inbox.length === 0
      ? messages
      : [...messages, ...inboxToMessages(inbox)]      // folds them in as user turns
  })
```

- **All at once.** `drain` is a single atomic `Ref.modify` that takes the whole mailbox and clears
  it. You don't get one message per turn — you get everything waiting, in arrival order.
- **Exactly once.** Drain clears the mailbox, so a message is delivered through exactly one path
  and never re-fed. (`wait_for_agents` also drains the caller's inbox into its result — whichever
  drains first wins; the other sees an empty box.)
- **Ephemeral.** The folded `[inbox …]` turns live in the in-memory buffer for that run; they are
  **not** persisted to the conversation store. The agent's *reply* is what's saved. (A deliberate
  trade — steering shouldn't rewrite the transcript; persisting verbatim is a possible follow-up.)
- **Turn-boundary, by design.** An agent can't usefully act on a message in the middle of a tool
  call, so the boundary is the natural — and only correct — injection point.

### Waking a parked agent

An agent gathering its fleet is parked in `wait_for_agents`, which `awaitChange` implements as a
race: *any watched child completing* vs *a message arriving in the caller's own inbox* vs *a
timeout*. A `post` fulfils the recipient's **wake latch**, so the parked agent returns at once
instead of sleeping out its timeout — that's what makes "you can always reach a busy agent" true.
It's interruptible (Esc tears it down) and bounded (default 60s, max 300s), so it can never
deadlock.

## The async lifecycle: spawn, then gather

This is the spine — spawning **does not block**:

```text
parent: run_agent({ agent: "backend", folder, task })
        → { nodeId, name, status: "running" }        ← returns immediately
        … (spawn more in parallel, or do other work) …
parent: wait_for_agents({ nodeIds: [...] })
        → parks until a child finishes / you message it / timeout
        → { agents: [{ nodeId, name, status, summary?, filesChanged? }],
            messages: [...your inbox...],
            notes: [...blackboard tail...],
            allDone }
child:  …runs its own loop in a background fiber…
        on finish → bus.complete(nodeId, result)
                    → fulfils the parent's wait, posts "finished: <summary>"
                      to the parent's mailbox + the blackboard, keeps the result
```

So a parent learns of a child's result **two ways**, redundantly: through `wait_for_agents` if it's
gathering, and through its mailbox at its next turn if it isn't. The bus also keeps a terminal
result record (and parent→child links, including finished children) so a `snapshot` reports an agent
that finished before the parent looked.

## Status, anytime

The bus is the live query layer the TUI and agents tap:

- `snapshot(nodeIds?)` — point-in-time status (`running` / `ok` / `error`) of any agents, with the
  summary + files of finished ones. Backs `wait_for_agents`' result.
- `listRunning()` / `childrenOf(parentKey)` — who's alive, who I spawned (running **and** finished).
- The TUI reads it for the header `◆ N agents` chip, `:fleet`, `:tree`, and a node preview — all
  update live because fleet runs (even background daemons) emit through the same event pump. The
  durable record stays the context tree; the bus is the *live* layer.

## Two "queues", kept distinct

Don't conflate them:

- **The mailbox** (above) is the in-flight steering channel — drained mid-run at turn boundaries,
  all-at-once, ephemeral.
- **The TUI pending queue** (`store.run`) is a between-turns backlog of things you typed while the
  root was busy *and unreachable*. With messaging in place it's mostly a fallback: a message typed
  while the root runs goes to the root's **mailbox** (delivered live); only if the root has no live
  mailbox does it queue, and `finishTurn` then drains one and re-submits it as a fresh turn (and
  requeues any human message that landed after the loop's last boundary, so nothing is lost).

## Teardown: no orphans

Because the fleet are background fibers that outlive the spawning turn, cancellation is explicit:
**Esc** interrupts the root fiber *and* `bus.interruptAll()` (every registered agent fiber), and a
runtime finalizer does the same on exit. `:stop` interrupts one. A run's `ensuring` always
`markDone`s its mailbox, so a parent waiting on it is woken even on interruption — the wait can
never hang.

## How we ensure it works

The protocol is covered by tests that exercise the real primitives (`agentBus.test.ts`,
`buildScopeRuntime.test.ts`):

- **Delivery into the loop** — a message posted to a running agent is folded into the *actual*
  prompt at the next turn boundary (asserted against what a recording model was prompted with), and
  the mailbox is cleared afterward (single delivery).
- **Non-blocking spawn + gather** — through the real loop: `run_agent` returns `status: "running"`
  immediately, and `wait_for_agents` later returns the finished agent's `ok` result.
- **Wake semantics** — `awaitChange` returns immediately when a watched agent is already done,
  wakes when a message arrives, and otherwise returns at the timeout (never hangs).
- **Completion routing** — `complete` records the result, fulfils the completion latch, and posts
  to the parent's mailbox + the blackboard.
- **Supervision** — `interruptAll` interrupts every registered fiber; `childrenOf` includes
  finished children; re-registering an agent keeps the original completion latch.

## Is this A2A?

No — and the difference is the point. Google's [A2A](https://a2a-protocol.org) is a **wire protocol
for opaque agents across process and vendor boundaries**: Agent Cards for capability discovery,
HTTP + JSON-RPC/SSE transport, a formal Task lifecycle, typed Message Parts, streaming and webhook
push, and the explicit premise that agents *don't* share memory, tools, or state.

efferent's premise is the opposite: a **cooperative team inside one runtime** that *does* share the
context tree, the token pool, and the blackboard, where a parent reads a child's summary directly.
The shapes rhyme — `run_agent` + `wait_for_agents` ≈ A2A's async task + poll/stream; bus status ≈
task states; the agent roster ≈ capability discovery; `complete` → mailbox ≈ task-completion
notification — but it's a lightweight in-process analog, deliberately not the transport.

If cross-process or cross-vendor interop is ever wanted, the clean seam is the `AgentBus` port plus
the `run_agent` / `wait_for_agents` tools: an adapter could front an A2A client/server there without
the loop or the prompts changing. Today it's all local fibers.
