# efferent — coding agent on Effect.ts + Bun

Coding agent CLI built in public as `@xandreeddev`. See `../CLAUDE.md` (parent tree) for the broader project rules — alias identity, OPSEC, weekly cadence, locked stack. See `PLAN.md` for the active design / pivot record.

## Architecture (ports & adapters)

```
packages/
├── core/         pure domain: entities, ports, use cases, prompts — depends on `effect` + `@effect/ai`
├── adapters/     Layer impls of ports — depends on @efferent/core + external SDKs (@effect/ai-google, @effect/ai-openai, Postgres)
└── cli/          coding-agent driver: TUI + print + json + rpc modes
```

**Dependency direction is strictly inward.** `cli` → `adapters` → `core`. `core` imports nothing from siblings. `adapters` imports `@efferent/core` + the external SDK it wraps. Drivers compose the layers at the very edge and hand off to `BunRuntime.runMain`.

## Conventions

- **Ports** are `Context.Tag` services in `@efferent/core/ports/`. Each ships its tagged errors next to it.
- **Adapters** provide one `Layer.effect` per port. External promises go through `Effect.tryPromise`, mapped into the port's tagged error. Config via `Config.string` — never hardcode.
- **Use cases** live in `@efferent/core/usecases/` returning `Effect.Effect<A, E, …>`. No IO; the only SDK allowed in `core` is `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`). Provider packages (`@effect/ai-google`, `@effect/ai-openai`) live in `adapters`.
- **Agent configs** (`@efferent/core/usecases/{agentConfig,coderAgentConfig}.ts`) bundle a system prompt + an `@effect/ai` `Toolkit` into an `AgentConfig<Tools>`. `runAgent` is parameterized by config; the CLI picks `coderAgentConfig(cwd)`. The toolkit's handler `Layer` (`codingToolkitLayer(cwd, skills, { allowBash })`) is provided at the driver's composition root — it carries the runtime deps (`cwd`, `FileSystem`, `Shell`).
- **Schema** lives in `effect` itself: `import { Schema } from "effect"`.
- Bun runs `.ts` directly. No build step, no emit. `tsc --noEmit` is purely a typecheck gate.
- File naming: camelCase for files that export functions; PascalCase for files that export types / `Context.Tag` classes.

## Dev commands

```bash
bun install                                          # from agent/ root only
bun run typecheck                                    # cross-package via path mappings
bun run build                                        # bundle the CLI → packages/cli/dist/efferent.js
bun run eval [name …]                                # run eval suites (key-gated)

# Postgres is OPTIONAL (only when EFFERENT_DB_URL is set); the default store is SQLite.
docker compose up -d                                 # start local Postgres (host port 5434)
docker compose down                                  # stop it
docker compose exec postgres psql -U agent -d agent  # poke at the DB

efferent init                                           # set up global ~/.efferent (key, default model)
efferent                                                # full TUI (TTY default)
efferent "<prompt>"                                     # one-shot print mode
efferent -p / --print                                   # explicit print mode (stdin OK with "-")
efferent --mode json "<prompt>"                         # stream events as JSONL on stdout
efferent --mode rpc                                     # bidirectional JSON-RPC on stdin/stdout
efferent --resume <conversationId>                      # resume an existing session
efferent --allow-bash                                   # allow bash in non-interactive modes
efferent --cwd <path>                                   # override workspace (defaults to process.cwd())
```

Config & env. Keys can come from env **or** the global `~/.efferent/auth.json` (written by `efferent init`); a real env var always wins. Settings (model, etc.) layer `~/.efferent/config.json` (global) under `<cwd>/.efferent/config.json` (workspace).
- `GOOGLE_GENERATIVE_AI_API_KEY` and/or `OPENAI_API_KEY` — at least one for any LLM call. The set keys gate which providers `/model` offers. A missing key only fails if you actually select that provider.
- `EFFERENT_DB_URL` — **optional.** Unset → zero-config **SQLite** at `~/.efferent/efferent.db` (the default; no Docker). Set to a Postgres URL (e.g. `postgres://agent:agent@localhost:5434/agent`) → Postgres instead. Selected at runtime in `adapters/src/database/migrator.ts` (`ConversationStoreLive`); migrations load via `Migrator.fromRecord` (bundle-safe).
- Optional `EFFERENT_MODEL` — seeds the active model when no `config.json` pins one. Accepts `"<provider>:<modelId>"` (e.g. `openai:gpt-4o`) or a bare id (provider inferred; defaults to Google). Default `google:gemini-3.5-flash`. An explicit `/model` switch is persisted to `.efferent/config.json` and wins over `EFFERENT_MODEL`.

## Install / distribution

Published as the unscoped npm package **`efferent`** (bin `efferent` / `eff`), a single self-contained Bun bundle (`bun run build` → `packages/cli/dist/efferent.js`, core + adapters inlined, `#!/usr/bin/env bun`). Requires **Bun** at runtime; zero runtime deps (the bundle inlines them; workspace + `@effect/*` are devDependencies). `npm i -g efferent` then `efferent init` → works in any project with no Docker (SQLite history under `~/.efferent/`). Do not publish without explicit sign-off (outward-facing).

## Coding tools (CLI)

An `@effect/ai` `Toolkit` in `@efferent/core/usecases/codingToolkit.ts`, backed by the `FileSystem` and `Shell` ports. Each tool is a `Tool.make` def with an **object** `success` Struct + a shared `failure` Struct and `failureMode: "return"` (so a tool failure is returned to the model as data, not thrown). Handlers live in `codingToolkitLayer(cwd, skills, { allowBash })`, which resolves `FileSystem`/`Shell` from context at layer-build time. (Gemini rules learned the hard way: every tool needs ≥1 parameter, and `success` must be an object — see the spike notes in the plan.)

| tool         | parameters                                       | implementation                              |
|--------------|--------------------------------------------------|---------------------------------------------|
| `read_file`  | `{ path; offset?; limit? }`                      | `FileSystem.read`                            |
| `write_file` | `{ path; content }`                              | `FileSystem.write`                           |
| `edit_file`  | `{ path; edits: [{ oldText; newText }] }`        | read → string replace → write, returns diff |
| `bash`       | `{ command; timeout? }`                          | `Shell.exec`, cwd bound at tool-build time  |
| `grep`       | `{ pattern; dir?; flags?; context? }`            | shells out to `grep -rnE` for now            |
| `glob`       | `{ pattern; dir? }`                              | `FileSystem.glob` via `Bun.Glob`             |
| `ls`         | `{ path?; recursive? }`                          | `FileSystem.list`                            |
| `web_fetch`  | `{ url; maxBytes? }`                             | `Http.get`; HTML reduced to text             |
| `web_search` | `{ query }`                                      | `WebSearch.search` → `{ answer; sources }`   |

All paths resolved relative to the `cwd` bound in `codingToolkitLayer(cwd)`. `web_search` is provider-native (see below) — it has no parameter-less constraint issue because `{ query }` satisfies the ≥1-parameter rule.

## Web search

Provider-native, no extra key. The `web_search` tool is backed by the `WebSearch` port (`@efferent/core/ports/WebSearch.ts`) and `WebSearchLive` (`adapters/src/llm/webSearch.ts`). Each call is a **dedicated, grounding-only** `generateText` against a provider's *server-side* search tool — Gemini `GoogleTool.GoogleSearch` or OpenAI `OpenAiTool.WebSearch` (`Tool.ProviderDefined`, handler-free). It returns `{ answer, sources }` (sources from the response's `UrlSourcePart`s). The model finds with `web_search`, then reads a chosen source with `web_fetch`.

**Deliberately a separate thing** (not merged into the agent's main toolkit): the search call carries *only* the search tool, never the agent's function tools — so it needs no extra key beyond the LLM provider key, and sidesteps providers (notably Gemini) that won't combine grounding with function calling in one request. It's also decoupled from the chat `/model`: configured via `EFFERENT_SEARCH_MODEL` (`<provider>:<modelId>`), else defaults to whichever provider key is set (Google preferred). `WebSearchLive` carries its own `ProviderClientsLive` (ModelLive's are internal). Gemini's grounding source URLs are `vertexaisearch…` redirects — `web_fetch` follows them.

## Agent loop

One use case — **`runAgent(config, conversationId, prompt, hooks?)`** in `@efferent/core/usecases/runAgent.ts` — drives the whole interaction. The loop lives in `@efferent/core/usecases/agentLoop.ts`. **`@effect/ai` resolves a single model step's tool calls (its handlers are our Effects) but does NOT iterate across turns — so iteration is ours**: each turn maps the message buffer to a `Prompt`, calls `LanguageModel.generateText({ prompt, toolkit })`, appends the response parts as the new tail, and re-invokes until `finishReason !== "tool-calls"` or `maxSteps`.

```
efferent <prompt>
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

**Prompt mapping** (`@efferent/core/usecases/promptMapping.ts`): bridges our persisted `AgentMessage` (Vercel-shaped, unchanged) with `@effect/ai`'s `Prompt`/`Response`. The opaque provider blob is carried verbatim both ways (`providerOptions ↔ options`/`metadata`), which is how Gemini's `thought_signature` round-trips across our turns — `Prompt.fromResponseParts` drops it, so we map by hand.

**Hooks** (`@efferent/core/AgentHooks`): the loop re-emits the legacy event vocabulary (`onTurnStart` / tool events / `onAssistantMessage`) from each resolved response, so the CLI's `makeEventHooks(queue)` (`packages/cli/src/events.ts`) and the TUI execution tree keep working unchanged.

**Graceful tool errors**: each tool's `failureMode: "return"` + `failure` Struct means a handler failure (e.g. `FileNotFound`, ambiguous edit) is returned to the model as a tool result instead of aborting the turn.

**Bash safety**: gated in the `bash` handler via the `allowBash` flag on `codingToolkitLayer` (denied → returned as a tool failure). Non-interactive modes pass `--allow-bash`; the TUI currently allows bash (interactive per-command confirm is a deferred follow-up).

## Handoff & conversation context

A **handoff** replaces the *loaded* history with a model-generated summary while keeping the originals. It's how a long session frees context without losing the record.

- **Storage** (`checkpoints` table, migration `0005`): a checkpoint is `{ messagePosition, summary }` for a conversation. Original `messages` rows are never modified. `ConversationStore` exposes `checkpoint(id, summary)` (atomic — folds at `COALESCE(MAX(position), -1)` in one statement), `getLatestCheckpoint`, `listCheckpoints`, `list` (ALL messages, for browsing), and `listActive` (only real rows **after** the latest fold).
- **Loading** (`runAgent`): loads `getLatestCheckpoint` + `listActive`, prepending the summary as a single synthetic `user` message via `handoffToMessage` (`promptMapping.ts`) — domain logic stays in core, not the adapter. So the model sees `[handoff summary] + [messages since the fold] + [new user msg]`; everything before the fold is preserved but never re-fed.
- **Creating** (`createHandoff`, `@efferent/core/usecases/handoff.ts`): summarizes the **currently loaded view** (prior summary + active window, never the raw `list`) with `HANDOFF_PROMPT` (`prompts/handoff.ts`, a Goal/State/Next-steps/Constraints brief) and writes a checkpoint. Summarizing the loaded view keeps handoffs **cumulative** — a second handoff folds the first summary back in. No-op when nothing new since the last fold.
- **TUI**: `:handoff` runs it (pushes a checkpoint block); `:context` toggles the **context viewer** in the side pane (`tui/contextView.ts` — `buildContextView` partitions `list` + `listCheckpoints` into *archived* segments (folded, not loaded) and the *loaded* segment; `buildContextRows` groups each segment's messages into **foldable, selectable turns**, rendered as a tree so the replacement is visible); `:browse` lists workspace conversations and `:resume <#|id>` switches to one (full replay for browsing, active-window for execution).
- **Curate context → new session**: in the context viewer, `Space` selects/deselects a **turn** *or* a **handoff** (the `⚑` archived-segment header) and `b` (or `:build`) **builds a new conversation** seeded with only the picked units, switching to it (`messagesForSelectedTurns` → `ConversationStore.create`/`append` → the `:resume` switch). A selected handoff contributes **only its summary, as one `handoffToMessage` message** (not the folded originals); a handoff and its own inner turns are therefore **mutually exclusive** (selecting one clears the other — `archivedTurnRanges`/`handoffOwningTurn` in `contextView.ts`). Turn granularity keeps tool-call/result pairs valid; the original conversation is untouched.

## CLI shape

Composition root: `packages/cli/src/main.ts`. Four modes under `packages/cli/src/modes/`:

- **`tui.ts`** — default in a TTY. Hand-rolled **modal, multi-pane**, Neogit-flavoured layout: **two separate bordered boxes** (`┌─ conversation ─┐ ┌─ activity ─┐`) with **one empty column between them**; each pane has a **distinct accent** when focused (conversation cyan / side magenta / input green — `PANE_ACCENT` in `render.ts`). A **bordered keybind box** (`legend.ts`) sits below — its border + title take the *focused* pane's accent and the title carries `<pane> · <MODE>` (the only place the vim mode shows; the status bar is `model · tokens · cwd`); its body is **two labelled rows** — a dim `nav` row (global movement: pane switching / `:` / `/` / zoom, identical in every pane) over a dynamic row of the focused pane's own keys. Plus a multi-line input box, a dim footer (logs path + key hints), a `:` command palette (`:exit`, `:clear`, `:help`, `:cwd`, `:reset`, `:handoff`, `:context`, `:build`, `:browse`, `:resume`, `:settings`, `:set`, `:model`) and a `/` search. Three focusable panes (conversation / side / input) swapped with **Ctrl-h/j/k/l or Ctrl-arrows**; **INSERT** only on the input, **NORMAL + VISUAL** on the read-only panes. The cursor is a **real nvim block cursor** (the hardware terminal cursor — block in NORMAL/VISUAL, bar in INSERT) with full motions (`h/j/k/l` + arrows, `w/b/e`·`W/B/E`, `0/^/$`, Home/End, `gg/G`, `{/}` turns, `Ctrl-D/U`); `v`/`V` charwise/linewise VISUAL + `y` yank (OSC 52). The conversation is a Claude-style **event rail**: assistant prose and each tool lead with a `●` (its colour carries run/ok/error), tool headers read `ToolName(arg)`, and the result hangs under a `⎿` connector with the diff/output beneath; it's still a tree of **foldable turns** ("commits", `▾`/`▸` chevron + the prompt, collapsing to `▸ <subject> · N steps`) with grouped tool calls — `Tab`/`Enter` fold the section under the cursor, `Z` all. The default side view is **activity** — an at-a-glance dashboard (context gauge, cumulative output/turns/elapsed, per-LLM-call token usage + duration per turn, a files-changed diffstat, and foldable skills/instructions sections that show a key-info summary when collapsed); navigable with its own block cursor (`j/k`·arrows·`gg/G`, `Tab`/`Enter`/`h`/`l`·←/→ fold the row — a section **or** a turn/sub-agent node) and **auto-collapses each completed step** as the next turn starts. The **context viewer** (`:context`) is a navigable tree of foldable, selectable **turns and handoffs** with its own block cursor: `Tab`/`h`/`l`·←/→ fold a turn or handoff segment, `Enter` jumps the conversation to it, `Space` selects a turn or a handoff (its summary), `b`/`:build` builds a new session from the selection. No React, no Ink, no blessed — just `Bun + ANSI` in `packages/cli/src/tui/`.
- **`print.ts`** — one-shot. Prompt from argv or stdin (`-`). Final text on stdout, tool log on stderr. Exits when done.
- **`json.ts`** — same control flow as print, but every `AgentEvent` is JSONL on stdout.
- **`rpc.ts`** — bidirectional JSON-RPC on stdin/stdout. Method: `agent.send({ prompt, conversationId? })` → emits `agent.event` notifications, resolves with `{ conversationId, finalText }`.

Modes share one `AgentEvent` union (`packages/cli/src/events.ts`); the loop's hooks push events onto a queue; each mode renders differently.

## Models & providers (multi-provider router)

The agent loop talks to one provider-agnostic `LanguageModel`; which provider/model backs it is a **runtime selection**, not a compile-time layer choice.

- **Router** (`adapters/src/llm/router.ts`, `RouterLanguageModelLive`): a `LanguageModel` whose `generateText`/`streamText`/`generateObject` read `ModelRegistry.current` on every call and delegate to the chosen provider's `@effect/ai` service, built on the fly from the captured `GoogleClient`/`OpenAiClient`. Switching model/provider needs no rebuild — the next turn reads the new selection.
- **Selection** lives in `SettingsStore` as `settings.model = "<provider>:<modelId>"` (the single source of truth, persisted to `.efferent/config.json`). `parseModel`/`formatModel`/`contextWindowFor` are pure helpers in `@efferent/core/entities/Model.ts`.
- **`ModelRegistry`** port (`@efferent/core/ports/ModelRegistry.ts`): `current` (parsed selection), `list` (live catalogue), `select` (persist + return). `ModelRegistryLive` (`adapters/src/llm/modelRegistry.ts`) fetches the catalogue over **raw HTTP** (Google `…/v1beta/models`, OpenAI `…/v1/models`) and parses defensively — the `@effect/ai-*` generated list schemas are stricter than the live APIs (Google omits `baseModelId`) and fail to decode through the SDK clients. Filters drop embeddings/image/tts/audio; only providers whose key is set are queried.
- **Clients** (`adapters/src/llm/clients.ts`): both `GoogleClient` + `OpenAiClient` built with **key-optional** config (`Config.option` → `undefined`), so a missing `OPENAI_API_KEY` never blocks a Google-only user; an absent key only 401s if that provider is actually used.
- **`ModelLive`** bundles router + `ModelRegistry` + dynamic `LlmInfo`; requires only `SettingsStore`. Replaces the old single-provider `GoogleLive`.

**`/model`** (TUI): no arg lists the live catalogue numbered + caches it; `/model <#|id>` switches, persists, updates the status bar. Switching provider mid-conversation applies going forward and surfaces a one-line hint (Gemini 400s on prior non-Gemini tool-calls that lack a `thought_signature` — `/reset` if it errors).

**Caching** is aggressive but provider-native: OpenAI gets automatic prompt-prefix caching + a stable `prompt_cache_key`; Gemini relies on implicit context caching (stable prefix → `cachedContentTokenCount`). Explicit Gemini `cachedContent` is not expressible through `@effect/ai-google` today (it always sends full `contents`), so we don't fake it.

## Token & model display

`LlmInfo.metadata` (provided by `ModelLive`, following the live `ModelRegistry.current`) exposes `{ modelId, contextWindow }`; the TUI status bar reads it at startup and `/model` updates it on switch. After each turn, `onAssistantMessage` carries a `TokenUsage` (input / output / total / cacheRead) for the gauge; `cacheReadTokens` comes from Gemini's `usageMetadata.cachedContentTokenCount`. Cache-read tokens shown dim: `18k (12k cached) / 1M`.

## Skills

`.efferent/skills/*.md` files are auto-discovered at startup. The search path walks `cwd → parents → ~/.efferent/skills/`; closer-to-cwd shadows farther on name collisions. Each skill file has YAML-ish frontmatter and a free-form markdown body:

```
---
name: <slug>
description: <one-line summary for the prompt>
---

(detailed procedure for the agent to follow)
```

At startup, names + descriptions are injected into the coder system prompt under a `# Skills` section. The bodies are lazy-loaded by the model via `read_skill({ name })` only when relevant. Pi-pattern; lets you ship reusable procedures without changing the code.

Loader: `loadSkills(cwd, homeDir)` in `@efferent/core/usecases/loadSkills.ts`. Failures (missing dirs, malformed frontmatter) are silently skipped — a broken skill never breaks the agent.

## Evals

A fourth package, **`packages/evals`** — a minimal, Effect-native eval library (Evalite's `data → task → scorers` shape re-expressed as Effects, so a `task` can be the real agent loop and a `Scorer` can itself call an LLM). Built when Evalite hit three hard incompatibilities at once (native `better-sqlite3` on Node 26, Vercel-AI-SDK coupling, Node-vs-Bun adapter APIs) — the "Evalite until it actively hurts" clause firing. No sqlite, no UI, no persistence; runs under Bun directly.

- **Framework** (`src/framework/`): `EvalSpec<I,O,T,R>` is pure data (`defineEval`); `runEval(spec)` returns `Effect<EvalReport, never, R>` — every per-case/per-scorer failure is captured via `Effect.exit` (so a provider 429 scores 0, never crashes the run) and `R` is left open for the caller to provide once. Scorers (`scorers.ts`): `predicate`, `includesAll` (substring-coverage ratio), `fromEffect`, and `llmJudge` (LLM-as-judge, parses `{"score","reason"}`). `report.ts` prints a coloured per-suite table.
- **Env** (`src/env.ts`): `EvalEnvLive` mirrors `main.ts`'s composition but swaps Postgres for an in-memory `ConversationStore` (`support/inMemoryConversationStore.ts`, replicating the position/checkpoint fold semantics) so evals need no Docker. `support/workspace.ts` gives `withTempWorkspace` (acquire/release temp dirs); `support/coder.ts` (`runCoder`) stands up a real coder agent over a temp repo and reports the tools it called + final text + read-back files.
- **Suites** (`src/suites/*.eval.ts`): `handoff` (seed a transcript → `createHandoff` → judge the summary), `tool-selection` (read-only intent, bounded to the first tool turn via an allow-list + `onShouldStopAfterTurn`, assert the first tool), `coder-edit` (full loop edits a temp file → read it back → assert + judge).
- **Run**: `bun run eval [name …] [--json]` (`src/run.ts`). Gated on `hasKey(GOOGLE_API_KEY|OPENAI_API_KEY)` — no key → suites skip cleanly. Unit tests (`bun test`) cover the framework (incl. captured failures) and the in-memory store fold contract, with no LLM.

## Deferred (do not build until they hurt)

Migration follow-ups (dropped when the loop moved onto `@effect/ai`):
- **Explicit Gemini context caching** — implicit caching is live (see Models & providers). Explicit `cachedContent` resources would need `@effect/ai-google` to let us send a trimmed `contents` + suppress system/tools; it can't today, so deferred. Cost optimisation, not correctness.
- **Scoped sub-agent delegation** — was `scopedAgentTools`/`runScopedAgent` (depended on the old `Llm` port). Re-add as `@effect/ai` tools whose handlers run a nested loop.
- **Interactive TUI bash confirm** — bash is now gated by the `allowBash` flag in the handler; the per-command y/n modal needs re-wiring through the handler (e.g. an approval service).
- **Live token streaming** — the loop uses `generateText` per turn; switch to `streamText` and map stream parts to events for token-level TUI updates.
- **Per-conversation OpenAI `prompt_cache_key`** — currently a stable static key; threading the conversation id would tighten cache routing.

- **Settings UI / config files** — a few knobs still hardcoded in `main.ts` composition (`/model` + `/set` cover model + the core settings).
- **Auto-compaction** — manual `:handoff` ships (see Handoff & conversation context). Automatic, token-threshold folding via `onTransformContext` (the hook is wired but unused) is the remaining piece; needs the loop's tail-persistence to be robust to a shrinking buffer first.
- **Streaming tool output** — bash stdout chunks back to the model live.
- **Branch / fork / session tree**; **extension system**; **parallel tool execution**.
- **Image attachments** in the CLI; **mouse support** in the TUI (intentionally none — the TUI stays out of mouse-reporting mode so terminal-native click-drag selection keeps working; navigation/selection is keyboard-modal: Ctrl-hjkl/Ctrl-arrows panes, j/k·arrows·gg/G·{/} scroll, `/` search, `v`+`y` yank); **native (non-shell-out) grep**.
- TUI follow-ups: **VISUAL select inside the input pane** (only the conversation pane selects today); **per-tool detail folding** (Ctrl-R is still a global toggle; turn + tool-group folding is per-section); **search-match centering refinements**. (The side pane now has a cursor, so "side-pane internal scroll" is done.)
- **Evals**: the `packages/evals` harness ships (see Evals). Deferred *within* it: result persistence / trend tracking across runs, an `onAfterToolCall`-driven trajectory scorer, dataset files (cases are inline today), CI wiring. Telemetry + structured logging beyond what `Effect.log` already prints.

## OPSEC reminder

Every commit under this tree must be authored as `Xand Reed <xandreed@proton.me>`. Verify with `git config user.email`. Parent CLAUDE.md is non-negotiable on this — never reference the real name in any file, commit, comment, or screenshot. Never commit anything from `~/Workspace/xandreed/pi` — it's read-only research material.
