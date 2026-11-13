# ADR 0006: A sub-agent is a session with a parent

- **Status:** accepted, 13 November 2026
- **Applies to:** `@xandreed/core/kernel`, `@xandreed/sdk/kernel` and every host that hands a task to an agent of its own
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A coding agent hands work to helpers: search this code, summarize that file, try this fix. Each helper
reads and writes far more than its caller needs back. Done in the caller's own conversation, that work
fills the caller's context, and every later request carries it. The question is what the kernel must add
so a turn can hand a task to an agent of its own and get back only its answer.

## Decision

Nothing new in the contracts. A sub-agent is a **session with a parent**, and the call that started it is
an ordinary tool call.

- **Its own session.** The helper's session is created with `parent: <caller's session>`
  (`Sessions.create`), which its header keeps; the sessions kit checks it (`create`). Its turn opens while
  the caller's is open: one session's turn does not hold another (`isolated`).
- **Its own agent.** The helper has its own system text, its own tools and its own memory of its own
  session. It runs the host's loop, the same loop function or another one, in its session.
- **A tool call in the caller's.** The caller's model calls a tool (`delegate`) whose handler runs the
  helper and returns its answer. The caller's journal holds the call and its result, nothing of the
  helper's work; the helper's journal holds its whole turn.
- **The result names the child.** The tool's result is `{ answer, session }`. That is the stored link from
  the call to the helper's session: it survives a reload, needs no event, no index of children and no
  change to storage, and a host draws the tree from it. The model sees the session id as part of the
  result; it is the helper's address, and costs a few tokens.
- **The handler does not hold the caller's session.** A tool handler is given its parameters only, so the
  helper is given the caller's session id by the host (in the learn track, the chat's session), not by
  the call.

## Consequences

- Helpers that delegate again are not built in this cut. They need two things: the loop's step limit
  bounds one turn, not helpers calling helpers, so a depth limit; and a `delegate` handler that knows the
  session it is called from, so a helper's helper is created under the helper and the `parent` chain,
  read with `Sessions.read(id)` up to a root, gives the depth. A handler is given its parameters only, so
  that means a handler built per caller (the sdk test's `ask(parent, task)` takes the parent for this
  reason) or the caller's session carried in the fiber. The learn track's helper gets no `delegate`.
- Running the helper in the caller's own session is refused: the caller's turn is open, so the helper's
  `open` fails `SessionBusy`.
- Helpers run one at a time inside the caller's tool call. Helpers that run while the caller goes on,
  and results delivered later, return with background tasks.

## What would reopen this

- A host that must find a session's children without the caller's journal (a store that lists them).
- A helper whose answer must reach the caller after the caller's turn has ended.
