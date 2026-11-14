# ADR 0007: A tool reaches the turn its call runs in through `CurrentTurn`

- **Status:** accepted, 14 November 2026
- **Applies to:** `@xandreed/sdk/kernel`, every host's loop and every tool that must reach its session
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A tool's handler is given its parameters only (Effect AI's `Toolkit`). Two needs ran into that:

- A sub-agent's helper is created with its caller's session as its parent (ADR 0006). With no way to
  know which session called it, a host gave every helper the chat's session, so a helper asked by a
  helper was filed under the chat, and the depth of helpers could not be read.
- A tool that shows something (a view for the UI, a record of its own) must append to the session its
  call came from.

Effect AI lets a tool declare services its handler needs (`Tool.make(name, { dependencies: [...] })`);
`toolkit.handle` then requires them where the call is made. A spike held it, typed and running: a
service provided around `toolkit.handle` reaches the handler.

## Decision

`CurrentTurn` (`@xandreed/sdk/kernel`, key `@xandreed/sdk/kernel/CurrentTurn`) is the `OpenSession` a tool
call runs in.

- **The loop provides it.** The host's loop runs each call with
  `toolkit.handle(...).pipe(Effect.provideService(CurrentTurn, session))`. It is the loop's, since the loop
  holds the open turn; the kernel adds no tool service (ADR 0004).
- **A tool declares it.** A tool whose handler needs its turn lists it in `dependencies` and reads it
  with `yield* CurrentTurn`. A loop that runs such a tool without providing it does not compile.
- **What a handler may do with it** is what a turn's body may do: read the journal, append records under
  its own name, create a session with it as the parent. The call and its result are still the loop's to
  store.

*Amended 14 November 2026.* Three things changed, and the decision above stands otherwise:

- **`CurrentTurn` is the turn a piece of work runs for, not a tool's alone.** It is provided by the function
  that already holds the open session, and by nothing else: `callTool` around a tool's handler,
  `modelAnswer` while the model's stream runs (so a wrapper of the model reaches the session its call is
  for), and the summary memory around its summarizer. A host's loop that uses those functions provides
  nothing by hand.
- **It hands a `RunningTurn`**: the open session, with reads and writes that cannot fail in their type. A
  tool's failures are the ones its schema declares, so a write the session refuses is a defect of the
  handler, which `callTool` stores as a failed result the model reads; one that fails while the model
  answers is a defect of that call, and fails the turn. A handler no longer wraps its writes in
  `Effect.orDie`.
- **The call's result is `callTool`'s to store**, not the loop's.

## Consequences

- Helpers can delegate again: a helper's helper is created under the helper, and the depth is read from
  the `parent` chain (`sub-agent.test.ts`). ADR 0006's "not built" becomes a host's choice of depth limit.
- A view or another record a tool appends lands in the journal between the call and its result, in the
  turn that made the call.
- A tool that declares nothing is unchanged, and a loop that provides `CurrentTurn` to it costs nothing.

## What would reopen this

- Tool calls run outside the turn that asked for them (background work), where no turn is open to give.
