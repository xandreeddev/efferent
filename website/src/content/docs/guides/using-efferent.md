---
title: Using efferent
description: The whole product in one arc — open a session, spin up a background fleet, attach your seat to any running agent, approve what they propose, shut down and resume. One workspace, many sessions, one seat.
sidebar:
  label: Using efferent
  order: 8
---

efferent is a coding agent that is also its own orchestrator — there is no separate "fleet app"
or "orchestrator mode." The agent you talk to can spawn, watch, and approve other agents, so the
quick one-off session and a coordinated background fleet are the *same thing* seen from different
angles. This guide is the whole arc, end to end. For the focused mechanics of each piece, follow
the links; this page is the shape of the product.

## One workspace · many sessions · one seat

The entire model is three words:

- **Workspace** — the project you opened efferent in. Everything happens here; the sandbox, the
  history, the fleet are all scoped to it.
- **Session** — the unit of work: one conversation with its agent loop, running as a fiber. Your
  foreground chat is a session; every agent you spawn is a session too. They run concurrently in
  one runtime (fibers, not processes — see the [fleet concept](/docs/concepts/fleet/)).
- **Seat** — your keyboard. It attaches to exactly **one** session at a time. The rest run in the
  background; you move your seat between them.

That's the whole cohesion. You never switch "modes" — you spawn sessions and move your seat. The
coder *is* the orchestrator.

## A quick session

Open efferent in a repo and just work — this is the focused, drive-it-turn-by-turn path:

```bash
efferent
```

You get the TUI: a conversation pane, an activity pane, and a composer. Type a task, watch it read,
edit, and run commands. No fleet, no ceremony — your seat is on the one session and that's all there
is. This is the Claude-Code-shaped experience, and most sessions never need more than it.

## Spin up a fleet

When the work is wider than one train of thought, the lead agent spawns helpers — or you fire them
yourself. Each runs **alongside** your conversation (your composer stays free):

```
:spawn reviewer packages/core "review the ports for missing error handling"
```

The model delegates the same way, and several spawns in disjoint folders run **in parallel**:

```
run_agent({ name: "review core", agent: "reviewer", folder: "packages/core", task: "…" })
```

The header's `◆ N agents` chip tracks the live fleet; the **sessions** pane and **`:tree`** are the
cockpit. Full walkthrough — roles, git-shareable agent/tool files, coordination, goals, scheduling —
in [Run a fleet](/docs/guides/fleet/).

## How agents work together

There's one substrate and three policies — you don't pick an architecture, you pick how much
coordination a job needs:

- **Substrate: parent → child.** Every spawn is a node in the [context tree](/docs/concepts/sub-agents/).
  This is always the wiring.
- **Solo** — one agent, no helpers. The substrate, used flat.
- **Team** — siblings share a **blackboard** and a **comms bus**, coordinating peer-to-peer
  (`blackboard_post` / `send_message`) so parallel workers don't clobber each other.
- **Orchestrator** — a lead with a standing **directive** plus `run_agent` and a fresh-context
  **verifier** that grades the work without grading itself.

Same tree underneath; the policy is just how the agents in it talk and what goal they share.

## Jump in, or just watch — the seat

A background session isn't a black box. Open it in `:tree` (`↵`) and you're looking at its live
activity. From there you either **watch** (read-only — the lead keeps streaming underneath) or
**drive** it: anything you type goes to that agent's mailbox and it picks it up at its next turn,
your composer never blocking. Type into a *finished* node and it resumes in place. Then detach back
to the lead.

## Background work proposes; you approve

Not every agent should act unsupervised. A background agent — a social drafter, a release prep, an
ops sweep — can gather data and **propose** an action rather than take it. You stay in control from
your seat: a proposal surfaces as a prompt you answer (`a` allow once · `s` this session · `p` this
project · `d` deny with a reason), and the decision feeds straight back to the agent.

This is live today for shell commands (the bash approval prompt, with a fast-tier judge that clears
routine work and only prompts on the exceptions — see
[the agent loop](/docs/concepts/agent-loop/)).

## Isolation

Parallel coders must not trample each other. Every spawned session is **write-confined to its
folder** — a write or bash command outside it comes back as a tool failure, not a silent escape —
and same-folder spawns **serialize on a per-folder lock**. Disjoint work is safe by construction;
overlapping work can't race. Reads stay workspace-wide, so a sub-agent still learns types and
conventions from anywhere in the tree.

## Shut down, come back

Sessions are durable. Every message is persisted to the workspace's store and the whole spawn tree
with it, so closing efferent loses nothing. Reopen and you land back on the session graph — the
startup picker offers the workspace's conversations, or jump straight in:

```bash
efferent --resume <conversationId>
```

`:sessions` lists every conversation on this workspace and swaps the active one; `:tree` browses the
full run tree to preview, fork, or resume any node. You stopped; you're back where you were.

## Extending efferent — two doors, both load at launch

You grow efferent two ways, and the line between them is firm: **compose existing capability with
files, or build new capability in code.**

**Compose with files.** Drop markdown in `.efferent/`:

- `agents/*.md` — a **role** = a system prompt + a tool allowlist.
- `tools/*.md` — a **declarative tool** = a shell or HTTP command template with `${param}` slots,
  run through the generic `run_tool`.
- `skills/*.md` — a **skill** = a procedure the agent loads on demand.

These are git-shareable and importable straight from GitHub (`:agents add github:…`), read at
**startup**. They compose what efferent already does — no new logic.

**Build a tool in code.** A genuinely new capability is a typed `Tool.make` plus an Effect handler
in the source (see [Define a tool](/docs/guides/define-a-tool/)). efferent is a coding agent on its
own codebase, so it can *write that tool itself* — but the change lands like any code: the type
checker and the no-`try/catch` ban gate it, and it's available on the **next launch**.

:::important[No runtime eval — and that's the point]
efferent never loads agent-authored *code* into the running process. New tools are typed Effects,
checked before they ship and loaded on relaunch; files only ever *compose* existing capability. So
every capability is reviewable, typed code — never an opaque blob the agent injected mid-run. The
agent can build its own tools; it just can't smuggle untyped logic past the gates.
:::

## Under the hood

One runtime, many fibers; the comms bus is a couple of refs; interrupting tears the whole subtree
down with no orphans. The durable record — conversations and the context tree — lives in SQLite,
orthogonal to the ephemeral running fibers. The deep dive, including the path to a headless daemon
clients attach to, is the [fleet concept](/docs/concepts/fleet/).
