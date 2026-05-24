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
- `GOOGLE_GENERATIVE_AI_API_KEY` — for any LLM call (capture, agent, render)
- `AGENT_DB_URL` — Postgres URL. Local default points at `postgres://agent:agent@localhost:5434/agent`
- Optional `AGENT_MODEL`. Defaults to `gemini-3.5-flash`. Provider is `@ai-sdk/google@3.x` (round-trips Gemini `thought_signature` fields, so multi-step tool calls work on 3.x models).

**Deployed Postgres** (Neon / Supabase / Railway / etc.): same code path — only `AGENT_DB_URL` changes. The `@effect/sql-pg` `PgClient` reads it, the migrator runs the same TS migrations from `packages/adapters/src/storage/migrations/`.

## Agent loop (web)

Both `/` and `/ui/stream` are thin entrypoints into one use case: **`runAgent`**. The agent — not the route handler — decides what to do. The loop is hand-rolled in `packages/adapters/src/llm/gemini.ts` as a functional pipeline: an immutable `LoopState` record is threaded through composed `LoopState => Effect<LoopState>` step functions (transformContext → turnStart → takeTurn → assistantMessage → decideContinuation → consultShouldStop → advanceTurn), and `Effect.iterate` drives turns until `stopRequested` or `maxSteps`. Each `takeTurn` calls `generateText({ stopWhen: stepCountIs(1) })` — the SDK does one step, the pipeline owns the rest.

```
browser prompt
  ↓ GET /ui/stream?prompt=… (cookie carries conversation_id)
runAgent(conversationId, prompt, hooks?)
  ├── ConversationStore.append(user)
  ├── ConversationStore.list → message history
  ├── Llm.runAgent({ system, messages, tools, hooks, maxSteps: 5 })
  │     ├── turn 0: applyTransformContext → emitTurnStart
  │     │           → takeTurn: generateText({ stopWhen: stepCountIs(1) })
  │     │             ├── per tool call (inside SDK execute): onBeforeToolCall (allow/block) → execute (graceful AgentToolError) → onAfterToolCall
  │     │             └── append response.messages onto LoopState.modelMessages
  │     │           → emitAssistantMessage → decideContinuation (stopRequested if finishReason !== "tool-calls" or no calls)
  │     │           → consultShouldStop (optional early exit) → advanceTurn
  │     └── Effect.iterate loops until stopRequested or turnIndex >= maxSteps
  ├── ConversationStore.append(assistant)
  └── return AgentResult { finalText, toolCalls, toolResults }
       ↓
renderUi(prompt, agentResult)   ← second-pass: stream HTML via Llm.streamGenerate
       ↓ merged into one SSE stream with step events: event: step / event: ui / event: ui-done / event: ui-error
browser appends chunks (cards) and renders pills (tool-call progress)
```

Two LLM calls per turn: the agent step (with tools, returns markdown) and the render step (streams HTML matching the `recipe-card` / `recipe-list` / `capture-card` / `empty-state` class vocabulary). Cookie-bound `conversation_id` makes follow-ups work ("now just the steps" → agent reads prior turns).

**Hooks** (`@agent/core/AgentHooks`): seven optional callbacks that the route layer attaches per-request. `RunAgent.ts` always installs a built-in `onAfterToolCall` to persist each tool result to `ConversationStore` as it happens (no end-of-turn batch). `chat.ts` adds `onBeforeToolCall` / `onAfterToolCall` that enqueue `event: step\ndata: {type, toolName, args|ok}` SSE frames. The client renders these as `tool-pill` chips above the streaming turn — orange-pulsing while running, green when done, red on error.

**Graceful tool errors**: the loop catches `AgentToolError` inside the SDK's `execute` callback and returns a structured `{ ok: false, tool, error, message }` payload instead of throwing. This means one tool failure (e.g. `CaptureNotFound` on a double-delete) no longer aborts the whole `generateText` call — the model sees the failure as data and recovers.

Tool definitions live in `packages/application/src/_tools/captureTools.ts` as domain `AgentTool` records (name + description + Effect Schema parameters + Effect-returning `execute`). The adapter (`gemini.ts`) translates them to Vercel AI SDK tools and uses `Effect.runtime` to bridge tool Effects back into the SDK's async `execute` callback.

The CLI (`agent capture` / `ls` / `show` / `rm`) bypasses the agent — direct verb commands hitting use cases. Useful for testing individual tools / direct ops, not part of the agent loop.

Base components are class-named (`recipe-card`, `recipe-list-item`, `capture-card`, `empty-state`) and live as a CSS *vocabulary* in `packages/web/src/views/shell.ts`; the render LLM is shown the same shapes as HTML snippets in `packages/application/src/_prompts/render-ui.ts` and emits final HTML matching them. There's no template engine yet — moving the components to `views/components/*.html` and/or switching to a `{component, props}` JSON contract is a future slice.

Streaming smoothing in the client: chunks are buffered until `<`/`>` counts balance before each `innerHTML` commit, so the browser never paints a partial tag as literal text. Per-element fade-up animations only fire on `.turn--done` so token-level re-renders during streaming don't replay them. The client also strips stray markdown fences (```\`\`\`html```) that the render LLM sometimes emits despite the prompt.

Known soft failure: when conversation history is long, the agent sometimes hallucinates tool calls (claims to have saved/deleted without invoking the tool). Mitigated by terser system prompts; properly fixed by trimming history or moving to a model with stricter tool-use grounding.

Local-only — no script-sanitisation yet, do not expose publicly.

## Deferred (do not build until they hurt)

- Evals / Evalite
- Compaction (Pi-style `transformContext`-based summarisation of old turns once context grows; the `onTransformContext` hook is already wired)
- Skills (markdown files in `.agent/skills/` discovered at startup; only name+description+location in the system prompt; bodies loaded on demand via a `read_skill` tool — the bloat-avoidance pattern from Pi)
- AGENTS.md cascade (replacing the static prompt with `~/.agent/AGENTS.md` → `.agent/AGENTS.md` → session)
- TS file extension loader (`.agent/extensions/*.ts` registering hooks/tools at startup)
- Interactive components — buttons inside rendered cards that fire `hx-post` to typed action routes (htmx finally earns its keep)
- Image capture from the web (today only the CLI accepts images)
- `{component, props}` typed render contract
- Script-injection sanitisation (do not expose publicly before this lands)
- Additional LLM providers, telemetry, structured logging

## OPSEC reminder

Every commit under this tree must be authored as `Xandre Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot.
