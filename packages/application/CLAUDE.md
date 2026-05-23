# @agent/application

Use cases — the layer that composes ports + domain into the things a driver wants to invoke.

## Contents

- One file per use case (e.g., `ClassifyMessage.ts`). Each exports a function returning `Effect.Effect<A, E, Port1 | Port2 | ...>`.
- `src/index.ts` re-exports the use-case functions.

## Rules

- Only `@agent/core` and `effect` may be imported.
- No SDK calls, no `fetch`, no `fs`. If you find yourself needing one, the use case is asking for a new port — go add it to `@agent/core/ports/` and depend on the Tag.
- Use cases are *pure orchestration*. Validation, branching, parallelism with `Effect.all`, retries with `Effect.retry`, etc. live here. The actual side effect happens inside the adapter the port resolves to.
- Keep handlers thin — one use case per intent. A growing use case is a signal to split it.
