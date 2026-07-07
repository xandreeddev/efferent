# stringStats

Implement a `stringStats` module at `src/stringStats.ts`.

## Goal

- `longest(words: ReadonlyArray<string>): Option<string>` — the longest word, `None` for an empty list.
- `histogram(words: ReadonlyArray<string>): ReadonlyMap<number, number>` — word-length counts.

## Acceptance (the gates)

- `longest` returns `Option<string>`, never `string | undefined` (`effect/no-nullable-return`).
- No `let` bindings — state is folded (`effect/no-let`).
- The module typechecks under `strict` + `noUncheckedIndexedAccess` (`typecheck`).

This spec is what `bun run foundry demo` forges: the scripted implementor fails
the idiom stage on attempt 1, the typecheck stage on attempt 2, and lands
clean on attempt 3 — one rejection per pipeline rank, each with a rendered
feedback brief. `--implementor claude` runs the same spec against a real
agent.
