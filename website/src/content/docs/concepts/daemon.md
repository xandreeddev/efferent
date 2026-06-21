---
title: The daemon
description: efferent runs the agent as a persistent per-workspace daemon — tmux-style — and the TUI (and a future web UI) are thin clients that attach over a swappable HTTP/SSE transport. The daemon owns all live state, survives a client closing, and is crash-restorable.
sidebar:
  label: The daemon
  order: 8
---

The agent doesn't have to live inside the terminal UI. efferent can run it as a
**persistent, per-workspace daemon** — like a tmux server — with the TUI (and, later,
a web UI) as **thin clients** that attach, stream events, and steer the same live
sessions. Close the UI and the daemon (and any running fleet) keeps going; reattach and
the view comes back. It's **opt-in** today behind `EFFERENT_REMOTE=1`; the in-process
TUI is still the default.

## Why

In-process, closing the terminal kills the fleet, live state is ephemeral, you can't
reattach, and a context node whose process dies is stranded `running` forever. The daemon
fixes all of that: it is the single authoritative owner of agent state, **any number of
clients** attach/detach freely, and a restart brings the sessions — their history, the
directive, the approvals — back, **auto-resuming a turn that was mid-flight** when it died.

## Three layers, dependency strictly inward

```
 clients (attach/detach, tmux-style)        daemon (persistent, one per workspace)
 ┌──────────────┐  commands (POST) ┌────────────────────────────────────────────┐
 │ TUI (OpenTUI) │ ───────────────▶ │ transport/http/server (HttpRouter + SSE)    │
 │ TUI #2 / web  │ ◀──── SSE ─────  │   └ in-process Workspace adapter (authority) │
 └──────────────┘  event stream    │       ├ buildScopeRuntime + bus + fleet      │
   (N clients, one session)         │       ├ per-session event ledger (PubSub+ring)│
        ▲ remote Workspace          │       ├ directive + approval ledger (server) │
        │ (transport-generic)       │       └ AppLive: stores, model, auth, settings│
        └ transport/http/client ────┴──────────────────┬─────────────────────────┘
                                     persisted (SQLite/PG): conversations, context tree,
                                     per-turn message tail, directive, approvals, in-flight marker
```

1. **The `Workspace` port + protocol (sdk-core, transport-agnostic).** The complete
   command/query surface a frontend needs — `snapshot`, `getState`, `send`, `interrupt`,
   `spawn`, `stop`, `subscribe → Stream<SeqEvent>`, `approve`, `get/setDirective`,
   `importAgents/Tools` — plus serializable Schemas for every command/event/state. No
   transport, no HTTP. The shared contract.
2. **Two `Workspace` implementations.** The **in-process** adapter wraps the real
   `buildScopeRuntime` + comms bus + fleet + stores; it's the authoritative owner of live
   state. The **remote** adapter implements the same interface by calling a transport
   client; its event stream feeds the TUI's existing reducer verbatim.
3. **The transport — a swappable last-layer adapter.** A server+client *pair* maps the
   protocol Schemas onto a wire. **HTTP + Server-Sent Events is the first pair** (chosen so
   a browser web UI *and* the terminal TUI can both attach); a unix-socket or websocket pair
   could drop in beside it with **no change to the agent or the UI**. `@effect/platform`
   HTTP appears in `transport/http/` and nowhere else.

The frontend is identical against either implementation: inject the in-process Workspace
and the TUI runs **daemonless** (a quick local/CI run, no transport at all); inject the
remote one and it attaches to the daemon. The transport is chosen at the composition root,
not baked into the UI.

## Multi-client fan-out

Each session has one **event ledger** — a monotonic sequence number on every event, a
bounded ring of recent events, and a `PubSub`. The producer is the one agent run; each
attached client `subscribe`s independently with its own cursor. So two TUIs, or a TUI and a
browser, on the same session both stream events live, both can send and steer, and both see
approvals. Detaching just drops the SSE stream; the daemon is unaffected.

## Reconnect & replay

A client streams from a sequence cursor. On a brief drop it reconnects with `?since=<seq>`;
the server replays the events it missed from the ring, then tails live — exactly once, in
order, with no gap at the seam. If the client's cursor predates the ring (e.g. across a
daemon restart) it re-fetches the full session state — a rebuild from the database — and
resumes. No event is ever silently lost.

## Crash-restorable

The database is the durable truth, not in-memory events. Each turn's messages are persisted
**as they land** (not only at run end), and a per-session **in-flight marker** records that a
turn is running. On restart the daemon:

- rebuilds every session, its history, the directive, and the approvals from the database;
- reconciles any context node left `running` by the crash;
- and **auto-resumes** a turn that was mid-flight — re-driving the loop over the persisted
  history (the model continues past tool results already recorded), bounded so a turn that
  crashes the daemon can't loop it.

## Approvals across the boundary

Bash approval still parks the agent fiber in the daemon. Instead of opening a local modal it
**publishes an `approval_needed` event** to every attached client; a client answers with
`approve` (a `POST`), which resumes the fiber and clears the sheet on the other clients. The
judge and the session/project rule ledger stay server-side — clients only trigger and
answer. Login stays client-side (the browser + credentials are the human's machine); a
`POST /auth/reload` tells the daemon to pick up a credential added in-session.

## Lifecycle

`efferent` (with `EFFERENT_REMOTE=1`) reads a discovery file
(`~/.efferent/daemon-<workspaceHash>.json`), attaches to a healthy daemon if one is
registered, and otherwise spawns a detached `--mode daemon-serve` and polls until it's up —
all transparent. The daemon boots **credential-less** on purpose: you log in from any
attached client and the router resolves the key per request, so a long-lived daemon survives
logins and logouts.
