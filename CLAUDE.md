# agent — hexagonal Effect.ts monorepo

Engineering assistant. Built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain + ports          depends only on `effect`
├── application/  use cases (Effect.gen)       depends on @agent/core
├── adapters/     Layer impls of ports         depends on @agent/core + external SDKs
├── cli/          @effect/cli driver           composition root
└── web/          htmx + SSE driver            generative UI server
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

docker compose up -d                                 # start local Postgres (host port 5434)
docker compose down                                  # stop it
docker compose exec postgres psql -U agent -d agent  # poke at the DB

agent --help                                         # via direnv bin/agent shim
agent capture <path-or-->                            # extract markdown via LLM and save
agent ls                                             # list saved captures
agent show <id-or-prefix>                            # print one
agent rm <id-or-prefix>                              # delete one

bun --hot packages/web/src/main.ts                   # web UI on :3000 (hot reload)
```

Required env (`.env`):
- `GOOGLE_GENERATIVE_AI_API_KEY` — for any LLM call (capture, classify)
- `AGENT_DB_URL` — Postgres URL. Local default points at `postgres://agent:agent@localhost:5434/agent`
- Optional `AGENT_MODEL` (default `gemini-3.5-flash`)

**Deployed Postgres** (Neon / Supabase / Railway / etc.): same code path — only `AGENT_DB_URL` changes. The `@effect/sql-pg` `PgClient` reads it, the migrator runs the same TS migrations from `packages/adapters/src/storage/migrations/`.

**Web / generative UI**: a ChatGPT-style page at `/` accepts a prompt (textarea, Enter to send, Shift+Enter newline); the server pre-fetches all captures, runs `RenderUi` (a UI-agent use case in `@agent/application`) which streams an HTML fragment via `Llm.streamGenerate`, and the client appends chunks into the latest turn's response container via SSE. Each turn = right-aligned user bubble + assistant content. The composer's Send button doubles as a Stop button during streaming.

Base components are class-named (`recipe-card`, `recipe-list-item`, `capture-card`, `empty-state`) and live as a CSS *vocabulary* in `packages/web/src/views/shell.ts`; the LLM is shown the same shapes as HTML snippets in `packages/application/src/_prompts/render-ui.ts` and emits final HTML matching them. There's no template engine yet — moving the components to `views/components/*.html` and/or switching to a `{component, props}` JSON contract is a future slice.

Streaming smoothing in the client: chunks are buffered until `<`/`>` counts balance before each `innerHTML` commit, so the browser never paints a partial tag as literal text. Per-element fade-up animations only fire on `.turn--done` so token-level re-renders during streaming don't replay them.

Local-only — no script-sanitisation yet, do not expose publicly.

## Deferred (do not build until they hurt)

- Web frontend (placeholder dir only)
- Evals / Evalite
- Persistence port — todos live in memory or nowhere until restart-loss is a real problem
- Streaming / SSE — `generateObject` returns one value
- Acting on classified intents (this round classifies only)
- Additional LLM providers, telemetry, structured logging

## OPSEC reminder

Every commit under this tree must be authored as `Xandre Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot.
