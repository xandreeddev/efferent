# agent — hexagonal Effect.ts monorepo

Engineering assistant. Built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain + ports          depends only on `effect`
├── application/  use cases (Effect.gen)       depends on @agent/core
├── adapters/     Layer impls of ports         depends on @agent/core + external SDKs
├── cli/          @effect/cli driver           composition root
└── web/          htmx + SSE driver            placeholder (not built yet)
```

**Dependency direction is strictly inward.** `cli` / `web` → `adapters` + `application` → `core`. `core` imports nothing from siblings. `application` imports only `@agent/core`. `adapters` imports `@agent/core` + the external SDK it wraps. Drivers compose the layers at the very edge and hand off to `BunRuntime.runMain`.

## Conventions

- **Ports** are `Context.Tag` services declared in `@agent/core/ports/`. Each ships a `Data.TaggedError` next to it for typed failures.
- **Adapters** provide one `Layer.effect` per port. Wrap external promises with `Effect.tryPromise`, map thrown values into the port's tagged error. Read config via `Config.string` — never hardcode.
- **Use cases** are functions in `@agent/application/` returning `Effect.Effect<A, E, Port1 | Port2>`. No IO, no SDK imports — only `@agent/core` and `effect`.
- **Schema** lives in `effect` itself: `import { Schema } from "effect"`. Not `@effect/schema`.
- Bun runs `.ts` directly. No build step, no emit. `tsc --noEmit` is purely a typecheck gate.

## Dev commands

```bash
bun install                                          # from agent/ root only
bun run typecheck                                    # cross-package via path mappings
bun packages/cli/src/main.ts --help                  # CLI help
bun packages/cli/src/main.ts classify "buy milk"     # vertical-slice smoke test
```

Requires `GOOGLE_GENERATIVE_AI_API_KEY` in `.env` for the `classify` call. Default model is `gemini-3.5-flash`, override with `AGENT_MODEL`.

## Deferred (do not build until they hurt)

- Web frontend (placeholder dir only)
- Evals / Evalite
- Persistence port — todos live in memory or nowhere until restart-loss is a real problem
- Streaming / SSE — `generateObject` returns one value
- Acting on classified intents (this round classifies only)
- Additional LLM providers, telemetry, structured logging

## OPSEC reminder

Every commit under this tree must be authored as `Xandre Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot.
