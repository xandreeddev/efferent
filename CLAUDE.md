# agent — coding agent on Effect.ts + Bun

Coding agent CLI built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack. See `PLAN.md` for the active design / pivot record.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain: entities, ports, use cases, prompts — depends on `effect` + `@effect/ai`
├── adapters/     Layer impls of ports — depends on @agent/core + external SDKs (@effect/ai-google, Postgres)
└── cli/          coding-agent driver: TUI + print + json + rpc modes
```

**Dependency direction is strictly inward.** `cli` → `adapters` → `core`. `core` imports nothing from siblings. `adapters` imports `@agent/core` + the external SDK it wraps. Drivers compose the layers at the very edge and hand off to `BunRuntime.runMain`.

## Conventions

- **Ports** are `Context.Tag` services in `@agent/core/ports/`. Each ships its tagged errors next to it.
- **Adapters** provide one `Layer.effect` per port. External promises go through `Effect.tryPromise`, mapped into the port's tagged error. Config via `Config.string` — never hardcode.
- **Use cases** live in `@agent/core/usecases/` returning `Effect.Effect<A, E, …>`. No IO; the only SDK allowed in `core` is `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`). Provider packages (`@effect/ai-google`) live in `adapters`.
- **Agent configs** (`@agent/core/usecases/{agentConfig,coderAgentConfig}.ts`) bundle a system prompt + an `@effect/ai` `Toolkit` into an `AgentConfig<Tools>`. `runAgent` is parameterized by config; the CLI picks `coderAgentConfig(cwd)`. The toolkit's handler `Layer` (`codingToolkitLayer(cwd, skills, { allowBash })`) is provided at the driver's composition root — it carries the runtime deps (`cwd`, `FileSystem`, `Shell`).
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
agent --allow-bash                                   # allow bash in non-interactive modes
agent --cwd <path>                                   # override workspace (defaults to process.cwd())
```

Required env (`.env`):
- `GOOGLE_GENERATIVE_AI_API_KEY` — for any LLM call.
- `AGENT_DB_URL` — Postgres URL for conversation history. Local default: `postgres://agent:agent@localhost:5434/agent`.
- Optional `AGENT_MODEL` — the Gemini model for the agent loop. Defaults to `gemini-3.5-flash`. Provider is `@effect/ai-google`, which surfaces Gemini `thought_signature` on response/prompt part metadata so multi-step tool calls round-trip (see `promptMapping.ts`).

## Coding tools (CLI)

An `@effect/ai` `Toolkit` in `@agent/core/usecases/codingToolkit.ts`, backed by the `FileSystem` and `Shell` ports. Each tool is a `Tool.make` def with an **object** `success` Struct + a shared `failure` Struct and `failureMode: "return"` (so a tool failure is returned to the model as data, not thrown). Handlers live in `codingToolkitLayer(cwd, skills, { allowBash })`, which resolves `FileSystem`/`Shell` from context at layer-build time. (Gemini rules learned the hard way: every tool needs ≥1 parameter, and `success` must be an object — see the spike notes in the plan.)

| tool         | parameters                                       | implementation                              |
|--------------|--------------------------------------------------|---------------------------------------------|
| `read_file`  | `{ path; offset?; limit? }`                      | `FileSystem.read`                            |
| `write_file` | `{ path; content }`                              | `FileSystem.write`                           |
| `edit_file`  | `{ path; edits: [{ oldText; newText }] }`        | read → string replace → write, returns diff |
| `bash`       | `{ command; timeout? }`                          | `Shell.exec`, cwd bound at tool-build time  |
| `grep`       | `{ pattern; dir?; flags?; context? }`            | shells out to `grep -rnE` for now            |
| `glob`       | `{ pattern; dir? }`                              | `FileSystem.glob` via `Bun.Glob`             |
| `ls`         | `{ path?; recursive? }`                          | `FileSystem.list`                            |

All paths resolved relative to the `cwd` bound in `codingToolkitLayer(cwd)`.

## Agent loop

One use case — **`runAgent(config, conversationId, prompt, hooks?)`** in `@agent/core/usecases/runAgent.ts` — drives the whole interaction. The loop lives in `@agent/core/usecases/agentLoop.ts`. **`@effect/ai` resolves a single model step's tool calls (its handlers are our Effects) but does NOT iterate across turns — so iteration is ours**: each turn maps the message buffer to a `Prompt`, calls `LanguageModel.generateText({ prompt, toolkit })`, appends the response parts as the new tail, and re-invokes until `finishReason !== "tool-calls"` or `maxSteps`.

```
agent <prompt>
  ↓
runAgent(coderAgentConfig(cwd), conversationId, prompt, hooks)
  ├── ConversationStore.append(user) ; list → message history
  ├── runAgentLoop({ system, messages, toolkit, hooks, maxSteps })
  │     ├── turn 0..N: onTransformContext? → onTurnStart
  │     │              → Prompt.make([system, ...toPromptMessages(messages)])
  │     │              → LanguageModel.generateText({ prompt, toolkit })   (resolves this step's tools)
  │     │              → responseToAgentMessages(res.content) onto buffer  (carries thought_signature in providerOptions)
  │     │              → re-emit onBeforeToolCall / onAfterToolCall / onAssistantMessage(TokenUsage) from the response
  │     │              → continue iff finishReason === "tool-calls" && toolCalls > 0 ; onShouldStopAfterTurn?
  │     └── while turnIndex < maxSteps
  ├── ConversationStore.append(tail)
  └── return AgentResult { finalText, messages }
```

**Prompt mapping** (`@agent/core/usecases/promptMapping.ts`): bridges our persisted `AgentMessage` (Vercel-shaped, unchanged) with `@effect/ai`'s `Prompt`/`Response`. The opaque provider blob is carried verbatim both ways (`providerOptions ↔ options`/`metadata`), which is how Gemini's `thought_signature` round-trips across our turns — `Prompt.fromResponseParts` drops it, so we map by hand.

**Hooks** (`@agent/core/AgentHooks`): the loop re-emits the legacy event vocabulary (`onTurnStart` / tool events / `onAssistantMessage`) from each resolved response, so the CLI's `makeEventHooks(queue)` (`packages/cli/src/events.ts`) and the TUI execution tree keep working unchanged.

**Graceful tool errors**: each tool's `failureMode: "return"` + `failure` Struct means a handler failure (e.g. `FileNotFound`, ambiguous edit) is returned to the model as a tool result instead of aborting the turn.

**Bash safety**: gated in the `bash` handler via the `allowBash` flag on `codingToolkitLayer` (denied → returned as a tool failure). Non-interactive modes pass `--allow-bash`; the TUI currently allows bash (interactive per-command confirm is a deferred follow-up).

## CLI shape

Composition root: `packages/cli/src/main.ts`. Four modes under `packages/cli/src/modes/`:

- **`tui.ts`** — default in a TTY. Hand-rolled three-region layout: status bar (model, live token gauge, cwd), scrollback (user / assistant / tool pills / info / error blocks), and a multi-line input editor with slash-command palette (`/exit`, `/clear`, `/help`, `/cwd`, `/reset`). No React, no Ink, no blessed — just `Bun + ANSI` in `packages/cli/src/tui/`.
- **`print.ts`** — one-shot. Prompt from argv or stdin (`-`). Final text on stdout, tool log on stderr. Exits when done.
- **`json.ts`** — same control flow as print, but every `AgentEvent` is JSONL on stdout.
- **`rpc.ts`** — bidirectional JSON-RPC on stdin/stdout. Method: `agent.send({ prompt, conversationId? })` → emits `agent.event` notifications, resolves with `{ conversationId, finalText }`.

Modes share one `AgentEvent` union (`packages/cli/src/events.ts`); the loop's hooks push events onto a queue; each mode renders differently.

## Token & model display

`LlmInfo.metadata` (provided by `GoogleLive`) exposes `{ modelId, contextWindow }`; the TUI status bar reads it at startup. After each turn, `onAssistantMessage` carries a `TokenUsage` (input / output / total / cacheRead) for the gauge; `cacheReadTokens` comes from Gemini's `usageMetadata.cachedContentTokenCount`. Cache-read tokens shown dim: `18k (12k cached) / 1M`.

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

Migration follow-ups (dropped when the loop moved onto `@effect/ai`):
- **Gemini context caching** — was the `LlmCache` port. Reimplement via `@effect/ai-google`'s `GoogleLanguageModel.Config` `cachedContent` field + the client's `CachedContent` create API. Cost optimisation, not correctness.
- **Scoped sub-agent delegation** — was `scopedAgentTools`/`runScopedAgent` (depended on the old `Llm` port). Re-add as `@effect/ai` tools whose handlers run a nested loop.
- **Interactive TUI bash confirm** — bash is now gated by the `allowBash` flag in the handler; the per-command y/n modal needs re-wiring through the handler (e.g. an approval service).
- **Live token streaming** — the loop uses `generateText` per turn; switch to `streamText` and map stream parts to events for token-level TUI updates.

- **Settings UI / config files / `/model` slash command** — knobs hardcoded in `main.ts` composition.
- **Compaction** — `onTransformContext` summarisation of old turns when context grows (hook is wired).
- **Streaming tool output** — bash stdout chunks back to the model live.
- **Branch / fork / session tree**; **extension system**; **parallel tool execution**.
- **Image attachments** in the CLI; **mouse support** in the TUI; **native (non-shell-out) grep**.
- **Evals / Evalite**, telemetry, structured logging beyond what `Effect.log` already prints.

## OPSEC reminder

Every commit under this tree must be authored as `Xand Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot. Never commit anything from `~/Workspace/xandreed/pi` — it's read-only research material.
