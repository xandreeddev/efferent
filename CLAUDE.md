# agent — coding agent on Effect.ts + Bun

Coding agent CLI built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack. See `PLAN.md` for the active design / pivot record.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain: entities, ports, use cases, prompts — depends only on `effect`
├── adapters/     Layer impls of ports — depends on @agent/core + external SDKs
├── cli/          coding-agent driver: TUI + print + json + rpc modes
└── web/          htmx + SSE driver (notes flow, not the coding agent)
```

**Dependency direction is strictly inward.** `cli` / `web` → `adapters` → `core`. `core` imports nothing from siblings. `adapters` imports `@agent/core` + the external SDK it wraps. Drivers compose the layers at the very edge and hand off to `BunRuntime.runMain`.

## Conventions

- **Ports** are `Context.Tag` services in `@agent/core/ports/`. Each ships its tagged errors next to it.
- **Adapters** provide one `Layer.effect` per port. External promises go through `Effect.tryPromise`, mapped into the port's tagged error. Config via `Config.string` — never hardcode.
- **Use cases** live in `@agent/core/usecases/` returning `Effect.Effect<A, E, Port1 | Port2>`. No IO, no SDK imports — only `@agent/core` and `effect`.
- **Agent configs** (`@agent/core/usecases/{notesAgentConfig,coderAgentConfig}.ts`) bundle a system prompt + tool set into an `AgentConfig<R>`. `runAgent` is parameterized by config — the CLI picks `coderAgentConfig(cwd)`, the web picks `notesAgentConfig`.
- **Schema** lives in `effect` itself: `import { Schema } from "effect"`.
- Bun runs `.ts` directly. No build step, no emit. `tsc --noEmit` is purely a typecheck gate.
- File naming: camelCase for files that export functions; PascalCase for files that export types / `Context.Tag` classes.

## Dev commands

```bash
bun install                                          # from agent/ root only
bun run typecheck                                    # cross-package via path mappings

docker compose up -d                                 # start local Postgres (host port 5434)
docker compose down                                  # stop it
docker compose exec postgres psql -U agent -d agent  # poke at the DB

agent                                                # full TUI (TTY default)
agent "<prompt>"                                     # one-shot print mode
agent -p / --print                                   # explicit print mode (stdin OK with "-")
agent --mode json "<prompt>"                         # stream events as JSONL on stdout
agent --mode rpc                                     # bidirectional JSON-RPC on stdin/stdout
agent --resume <conversationId>                      # resume an existing session
agent --allow-bash                                   # skip bash confirms (non-interactive)
agent --cwd <path>                                   # override workspace (defaults to process.cwd())

bun --hot packages/web/src/main.ts                   # web UI on :3000 (notes flow)
```

Required env (`.env`):
- `GOOGLE_GENERATIVE_AI_API_KEY` — for any LLM call.
- `AGENT_DB_URL` — Postgres URL for conversation history. Local default: `postgres://agent:agent@localhost:5434/agent`.
- Optional `AGENT_MODEL` — smart tier (agent loop). Defaults to `gemini-3.5-flash`. Provider is `@ai-sdk/google@3.x` (round-trips Gemini `thought_signature`, so multi-step tool calls work on 3.x).
- Optional `AGENT_FAST_MODEL` — fast tier for non-loop calls (web's `renderUi` second pass + capture extraction; eventually compaction / session titles). Defaults to `gemini-3.5-flash-lite`.

## Coding tools (CLI)

Seven `AgentTool` records in `@agent/core/usecases/codingTools.ts`, backed by the `FileSystem` and `Shell` ports:

| tool         | parameters                                       | implementation                              |
|--------------|--------------------------------------------------|---------------------------------------------|
| `read_file`  | `{ path; offset?; limit? }`                      | `FileSystem.read`                            |
| `write_file` | `{ path; content }`                              | `FileSystem.write`                           |
| `edit_file`  | `{ path; edits: [{ oldText; newText }] }`        | read → string replace → write, returns diff |
| `bash`       | `{ command; timeout? }`                          | `Shell.exec`, cwd bound at tool-build time  |
| `grep`       | `{ pattern; dir?; flags?; context? }`            | shells out to `grep -rnE` for now            |
| `glob`       | `{ pattern; dir? }`                              | `FileSystem.glob` via `Bun.Glob`             |
| `ls`         | `{ path?; recursive? }`                          | `FileSystem.list`                            |

All paths resolved relative to the cwd baked into `buildCodingTools(cwd)`.

## Agent loop

One use case — **`runAgent(config, conversationId, prompt, hooks?)`** in `@agent/core/usecases/runAgent.ts` — drives the whole interaction. The mode-agnostic loop is in `@agent/core/usecases/agentLoop.ts`: an immutable `LoopState` threaded through composed `LoopState => Effect<LoopState>` step functions (transformContext → turnStart → takeTurn → assistantMessage → decideContinuation → consultShouldStop → advanceTurn), driven by `Effect.iterate` until `stopRequested` or `maxSteps`. Each `takeTurn` calls `Llm.runTurn` which wraps `generateText({ stopWhen: stepCountIs(1) })` — the SDK does one step, the loop owns the rest.

```
agent <prompt>
  ↓
runAgent(coderAgentConfig(cwd), conversationId, prompt, hooks)
  ├── ConversationStore.append(user)
  ├── ConversationStore.list → message history
  ├── runAgentLoop({ system, messages, tools, hooks, maxSteps: 5 })
  │     ├── turn 0..N: applyTransformContext → emitTurnStart
  │     │              → takeTurn (Llm.runTurn → generateText, stop=stepCountIs(1))
  │     │                ├── per tool call: onBeforeToolCall (allow/block) → execute (graceful AgentToolError) → onAfterToolCall
  │     │                └── append response.messages onto LoopState.messages
  │     │              → emitAssistantMessage (carries TokenUsage) → decideContinuation → consultShouldStop → advanceTurn
  │     └── Effect.iterate until stopRequested or turnIndex >= maxSteps
  ├── ConversationStore.append(tail)
  ├── Llm.snapshot → store per-(conversation, config) cache hint
  └── return AgentResult { finalText, messages }
```

**Hooks** (`@agent/core/AgentHooks`): seven optional callbacks. The CLI installs hooks per mode via `makeEventHooks(queue, beforeToolHook)` in `packages/cli/src/events.ts`, plus safety hooks (`bashConfirmHook` for TUI, `denyBashHook` for non-interactive without `--allow-bash`) in `packages/cli/src/safetyHooks.ts`.

**Graceful tool errors**: the adapter (`vercelAi.ts`) catches `AgentToolError` inside the SDK's `execute` callback and returns a structured `{ ok: false, tool, error, message }` payload instead of throwing. One tool failure (e.g., `FileNotFound`) no longer aborts the whole turn — the model sees the failure as data and recovers.

**Bash safety**: TUI mode shows a centered y/n modal before each `bash` call. Print/JSON/RPC modes block `bash` unless `--allow-bash` was passed. The block surfaces as a tool-result, not an exception.

## CLI shape

Composition root: `packages/cli/src/main.ts`. Four modes under `packages/cli/src/modes/`:

- **`tui.ts`** — default in a TTY. Hand-rolled three-region layout: status bar (model, live token gauge, cwd), scrollback (user / assistant / tool pills / info / error blocks), and a multi-line input editor with slash-command palette (`/exit`, `/clear`, `/help`, `/cwd`, `/reset`). No React, no Ink, no blessed — just `Bun + ANSI` in `packages/cli/src/tui/`.
- **`print.ts`** — one-shot. Prompt from argv or stdin (`-`). Final text on stdout, tool log on stderr. Exits when done.
- **`json.ts`** — same control flow as print, but every `AgentEvent` is JSONL on stdout.
- **`rpc.ts`** — bidirectional JSON-RPC on stdin/stdout. Method: `agent.send({ prompt, conversationId? })` → emits `agent.event` notifications, resolves with `{ conversationId, finalText }`.

Modes share one `AgentEvent` union (`packages/cli/src/events.ts`); the loop's hooks push events onto a queue; each mode renders differently.

## Token & model display

`Llm.metadata` exposes `{ modelId, contextWindow }`; the TUI status bar reads it at startup. After each turn, `onAssistantMessage` carries a `TokenUsage` (input / output / total / cacheRead) that the status bar uses to redraw the gauge. Cache-read tokens shown dim: `18k (12k cached) / 1M`.

## Web flow (notes — unchanged)

`packages/web/src/routes/chat.ts` passes `notesAgentConfig` to `runAgent`. Two LLM calls per turn: the agent step (notes-flavoured prompt + capture tools) and a second-pass `renderUi` that streams HTML matching the `recipe-card` / `capture-card` / `empty-state` class vocabulary. Cookie-bound `conversation_id`. Local-only — no script-sanitisation yet, do not expose publicly.

## Skills

`.agent/skills/*.md` files are auto-discovered at startup. The search path walks `cwd → parents → ~/.agent/skills/`; closer-to-cwd shadows farther on name collisions. Each skill file has YAML-ish frontmatter and a free-form markdown body:

```
---
name: <slug>
description: <one-line summary for the prompt>
---

(detailed procedure for the agent to follow)
```

At startup, names + descriptions are injected into the coder system prompt under a `# Skills` section. The bodies are lazy-loaded by the model via `read_skill({ name })` only when relevant. Pi-pattern; lets you ship reusable procedures without changing the code.

Loader: `loadSkills(cwd, homeDir)` in `@agent/core/usecases/loadSkills.ts`. Failures (missing dirs, malformed frontmatter) are silently skipped — a broken skill never breaks the agent.

## Deferred (do not build until they hurt)

- **Settings UI / config files / `/model` slash command** — knobs hardcoded in `main.ts` composition.
- **Compaction** — Pi-style `transformContext` summarisation of old turns when context grows. The `onTransformContext` hook is already wired.
- **Token-level assistant streaming** — v1 paints the assistant block once per turn after the model finishes.
- **Streaming tool output** — bash stdout chunks back to the model live.
- **Branch / fork / session tree** (Pi's `--fork`, `/tree`).
- **Extension system** (Pi's `extensions/`).
- **Sub-agents** / parallel tool execution.
- **Image attachments** in the CLI.
- **Mouse support** in the TUI.
- **Native (non-shell-out) grep**.
- **Evals / Evalite**, telemetry, structured logging beyond what `Effect.log` already prints.
- **Settled fate of the capture/notes domain** beyond removing it from the CLI; web still uses it.

## OPSEC reminder

Every commit under this tree must be authored as `Xand Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot. Never commit anything from `~/Workspace/xandreed/pi` — it's read-only research material.
