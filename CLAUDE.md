# agent — coding agent on Effect.ts + Bun

Coding agent CLI built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack. See `PLAN.md` for the active design / pivot record.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain: entities, ports, use cases, prompts — depends on `effect` + `@effect/ai`
├── adapters/     Layer impls of ports — depends on @agent/core + external SDKs (@effect/ai-google, @effect/ai-openai, Postgres)
└── cli/          coding-agent driver: TUI + print + json + rpc modes
```

**Dependency direction is strictly inward.** `cli` → `adapters` → `core`. `core` imports nothing from siblings. `adapters` imports `@agent/core` + the external SDK it wraps. Drivers compose the layers at the very edge and hand off to `BunRuntime.runMain`.

## Conventions

- **Ports** are `Context.Tag` services in `@agent/core/ports/`. Each ships its tagged errors next to it.
- **Adapters** provide one `Layer.effect` per port. External promises go through `Effect.tryPromise`, mapped into the port's tagged error. Config via `Config.string` — never hardcode.
- **Use cases** live in `@agent/core/usecases/` returning `Effect.Effect<A, E, …>`. No IO; the only SDK allowed in `core` is `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`). Provider packages (`@effect/ai-google`, `@effect/ai-openai`) live in `adapters`.
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
- `GOOGLE_GENERATIVE_AI_API_KEY` and/or `OPENAI_API_KEY` — at least one for any LLM call. The set keys gate which providers `/model` offers. Either key is optional at startup (a missing key only fails if you actually select that provider).
- `AGENT_DB_URL` — Postgres URL for conversation history. Local default: `postgres://agent:agent@localhost:5434/agent`.
- Optional `AGENT_MODEL` — seeds the active model when no `.agent/config.json` pins one. Accepts `"<provider>:<modelId>"` (e.g. `openai:gpt-4o`) or a bare id (provider inferred; defaults to Google). Default `google:gemini-3.5-flash`. An explicit `/model` switch is persisted to `.agent/config.json` and wins over `AGENT_MODEL`.

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

- **`tui.ts`** — default in a TTY. Hand-rolled **modal, multi-pane** layout: a fixed top hint bar, the middle (scrollback ¦ optional side pane), and a multi-line input — plus a `:` command palette (`:exit`, `:clear`, `:help`, `:cwd`, `:reset`, `:settings`, `:set`, `:model`) and a `/` conversation search. Three focusable panes (conversation / side / input) swapped with **Ctrl-h/j/k/l**; per-pane modes — **INSERT** only on the input, **NORMAL + VISUAL** on the read-only panes. NORMAL gives vim scroll motions (j/k, gg/G, {/}, Ctrl-D/U) and `/` search (n/N); VISUAL selects lines and `y` yanks to the clipboard (OSC 52). No React, no Ink, no blessed — just `Bun + ANSI` in `packages/cli/src/tui/`.
- **`print.ts`** — one-shot. Prompt from argv or stdin (`-`). Final text on stdout, tool log on stderr. Exits when done.
- **`json.ts`** — same control flow as print, but every `AgentEvent` is JSONL on stdout.
- **`rpc.ts`** — bidirectional JSON-RPC on stdin/stdout. Method: `agent.send({ prompt, conversationId? })` → emits `agent.event` notifications, resolves with `{ conversationId, finalText }`.

Modes share one `AgentEvent` union (`packages/cli/src/events.ts`); the loop's hooks push events onto a queue; each mode renders differently.

## Models & providers (multi-provider router)

The agent loop talks to one provider-agnostic `LanguageModel`; which provider/model backs it is a **runtime selection**, not a compile-time layer choice.

- **Router** (`adapters/src/llm/router.ts`, `RouterLanguageModelLive`): a `LanguageModel` whose `generateText`/`streamText`/`generateObject` read `ModelRegistry.current` on every call and delegate to the chosen provider's `@effect/ai` service, built on the fly from the captured `GoogleClient`/`OpenAiClient`. Switching model/provider needs no rebuild — the next turn reads the new selection.
- **Selection** lives in `SettingsStore` as `settings.model = "<provider>:<modelId>"` (the single source of truth, persisted to `.agent/config.json`). `parseModel`/`formatModel`/`contextWindowFor` are pure helpers in `@agent/core/entities/Model.ts`.
- **`ModelRegistry`** port (`@agent/core/ports/ModelRegistry.ts`): `current` (parsed selection), `list` (live catalogue), `select` (persist + return). `ModelRegistryLive` (`adapters/src/llm/modelRegistry.ts`) fetches the catalogue over **raw HTTP** (Google `…/v1beta/models`, OpenAI `…/v1/models`) and parses defensively — the `@effect/ai-*` generated list schemas are stricter than the live APIs (Google omits `baseModelId`) and fail to decode through the SDK clients. Filters drop embeddings/image/tts/audio; only providers whose key is set are queried.
- **Clients** (`adapters/src/llm/clients.ts`): both `GoogleClient` + `OpenAiClient` built with **key-optional** config (`Config.option` → `undefined`), so a missing `OPENAI_API_KEY` never blocks a Google-only user; an absent key only 401s if that provider is actually used.
- **`ModelLive`** bundles router + `ModelRegistry` + dynamic `LlmInfo`; requires only `SettingsStore`. Replaces the old single-provider `GoogleLive`.

**`/model`** (TUI): no arg lists the live catalogue numbered + caches it; `/model <#|id>` switches, persists, updates the status bar. Switching provider mid-conversation applies going forward and surfaces a one-line hint (Gemini 400s on prior non-Gemini tool-calls that lack a `thought_signature` — `/reset` if it errors).

**Caching** is aggressive but provider-native: OpenAI gets automatic prompt-prefix caching + a stable `prompt_cache_key`; Gemini relies on implicit context caching (stable prefix → `cachedContentTokenCount`). Explicit Gemini `cachedContent` is not expressible through `@effect/ai-google` today (it always sends full `contents`), so we don't fake it.

## Token & model display

`LlmInfo.metadata` (provided by `ModelLive`, following the live `ModelRegistry.current`) exposes `{ modelId, contextWindow }`; the TUI status bar reads it at startup and `/model` updates it on switch. After each turn, `onAssistantMessage` carries a `TokenUsage` (input / output / total / cacheRead) for the gauge; `cacheReadTokens` comes from Gemini's `usageMetadata.cachedContentTokenCount`. Cache-read tokens shown dim: `18k (12k cached) / 1M`.

## Skills

Skills are markdown files with YAML-ish frontmatter and a free-form body, loaded from two kinds of source:

- **Internal (bundled)** — base capabilities shipped with the agent, in `packages/cli/skills/*.md`. `main.ts` resolves that dir off its own module URL and passes it to the loader, so it works from any cwd. First bundled skill: **`web-search`** (Brave Search API, see below).
- **External (workspace/user)** — `.agent/skills/*.md` walked `cwd → parents → ~/.agent/skills/`.

```
---
name: <slug>
description: <one-line summary for the prompt>
---

(detailed procedure for the agent to follow)
```

At startup, names + descriptions are injected into the coder system prompt under a `# Skills` section (internal ones tagged `(built-in)`). Bodies are lazy-loaded by the model via `read_skill({ name })` only when relevant. Pi-pattern; ship reusable procedures without changing code.

Loader: `loadSkills(cwd, homeDir, internalDir?)` in `@agent/core/usecases/loadSkills.ts`. External sources are searched first, the internal dir last, deduped by `name` (first wins) — so a workspace skill **shadows** a built-in of the same name. Each `Skill` carries `internal: boolean`. Failures (missing dirs, malformed frontmatter) are silently skipped — a broken skill never breaks the agent.

**Script-backed skills**: a skill body may reference its own directory via the `{{SKILL_DIR}}` token, substituted by `read_skill` with the absolute dir of the source `.md`. This lets a skill ship a sidecar executable next to it (e.g. `web-search.js`) and invoke it via `bash {{SKILL_DIR}}/script.js` regardless of cwd. `web-search` needs `BRAVE_API_KEY` (free tier) and `bash` permitted; it finds pages, the built-in `web_fetch` tool reads them.

## Deferred (do not build until they hurt)

Migration follow-ups (dropped when the loop moved onto `@effect/ai`):
- **Explicit Gemini context caching** — implicit caching is live (see Models & providers). Explicit `cachedContent` resources would need `@effect/ai-google` to let us send a trimmed `contents` + suppress system/tools; it can't today, so deferred. Cost optimisation, not correctness.
- **Scoped sub-agent delegation** — was `scopedAgentTools`/`runScopedAgent` (depended on the old `Llm` port). Re-add as `@effect/ai` tools whose handlers run a nested loop.
- **Interactive TUI bash confirm** — bash is now gated by the `allowBash` flag in the handler; the per-command y/n modal needs re-wiring through the handler (e.g. an approval service).
- **Live token streaming** — the loop uses `generateText` per turn; switch to `streamText` and map stream parts to events for token-level TUI updates.
- **Per-conversation OpenAI `prompt_cache_key`** — currently a stable static key; threading the conversation id would tighten cache routing.

- **Settings UI / config files** — a few knobs still hardcoded in `main.ts` composition (`/model` + `/set` cover model + the core settings).
- **Compaction** — `onTransformContext` summarisation of old turns when context grows (hook is wired).
- **Streaming tool output** — bash stdout chunks back to the model live.
- **Branch / fork / session tree**; **extension system**; **parallel tool execution**.
- **Image attachments** in the CLI; **mouse support** in the TUI (intentionally none — the TUI stays out of mouse-reporting mode so terminal-native click-drag selection keeps working; navigation/selection is keyboard-modal: Ctrl-hjkl panes, j/k·gg/G·{/} scroll, `/` search, `v`+`y` yank); **native (non-shell-out) grep**.
- TUI follow-ups: **VISUAL select inside the input pane** (only the conversation pane selects today); **side-pane internal scroll** (j/k when the side pane is focused — its content is short, so deferred); **search-match centering refinements**.
- **Evals / Evalite**, telemetry, structured logging beyond what `Effect.log` already prints.

## OPSEC reminder

Every commit under this tree must be authored as `Xand Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot. Never commit anything from `~/Workspace/xandreed/pi` — it's read-only research material.
