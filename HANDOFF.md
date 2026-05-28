# Handoff

_Last updated: 2026-05-28._

## TL;DR

The agent was migrated off the **Vercel AI SDK** onto **`@effect/ai`** with a **multi-provider router** over `@effect/ai-google` (Gemini) + `@effect/ai-openai` (OpenAI). It works end-to-end (verified in `print` mode with real multi-step Gemini tool calls; live model catalogue fetch verified). A runtime **`/model` switch** picks provider + model from a live catalogue; selection persists to `.agent/config.json`; caching is provider-native + aggressive.

---

## What shipped (commits on `main`)

| commit | what |
|--------|------|
| `0c80056` | drop the `web` package + the orphaned notes/capture/`renderUi`/`LlmFast` domain; relocate `AgentConfig` |
| `19e4813` | add the `@effect/ai` coding `Toolkit` (`codingToolkit.ts`) |
| `195add3` | add the `@effect/ai-google` `LanguageModel` adapter (`llm/google.ts`) |
| `b3b84f6` | move the agent loop onto `@effect/ai` (the big flip) |
| `8762995` | drop dead Vercel deps (`ai`/`@ai-sdk/google`/`@google/genai`); update both `CLAUDE.md` |
| `7ffb5b2` | fix: TUI process hung after exit (pause stdin on teardown) |

`bun run typecheck` is green. Old `Llm` port, `AgentTool`, `gemini.ts`/`vercelAi.ts`, `codingTools.ts` are gone.

---

## Architecture now

- **`core`** depends on `effect` + `@effect/ai` (provider-agnostic). `@effect/ai`'s `LanguageModel` **is** the agent-loop port; `Tool`/`Toolkit`/`Prompt` are the vocabulary. Provider packages (`@effect/ai-google`) live in **`adapters`**. `cli` → `adapters` → `core`.
- **Loop** (`core/src/usecases/agentLoop.ts`): `@effect/ai` resolves a *single* model step's tool calls (handlers are our Effects) but does **not** iterate across turns — **iteration is ours**. Each turn: map buffer → `Prompt`, `LanguageModel.generateText({ prompt, toolkit })`, append response parts as the new tail, repeat while `finishReason === "tool-calls"` and `< maxSteps`.
- **Tools** (`core/src/usecases/codingToolkit.ts`): `Tool.make` defs + a `toLayer` handler `Layer` bound to `cwd`, resolving `FileSystem`/`Shell` from context. Provided per-mode via `codingToolkitLayer(cwd, skills, { allowBash })`.
- **Message bridge** (`core/src/usecases/promptMapping.ts`): persisted `AgentMessage` (Vercel-shaped, unchanged in Postgres) ⇄ `@effect/ai` `Prompt`/`Response`. Carries the opaque provider blob verbatim (`providerOptions ↔ options`/`metadata`).
- **Events**: the loop re-emits the legacy `AgentEvent` hook vocabulary from each response, so `cli/src/events.ts` + the TUI execution tree are unchanged.
- **Composition root**: `cli/src/main.ts` → `GoogleLive` (`LanguageModel` + `LlmInfo`) + `LocalFileSystem`/`LocalShell`/`PostgresConversationStore`/`LocalSettingsStore`.

---

## Hard-won `@effect/ai` gotchas (don't relearn these)

1. **Single-step, not a loop.** `generateText`/`streamText` resolve one step's tools then return `finishReason: "tool-calls"`. We own iteration.
2. **`Prompt.fromResponseParts` drops `thought_signature`.** Gemini *requires* it on `functionCall` parts in follow-up requests, or it 400s. We never use `fromResponseParts`; `promptMapping` carries the signature verbatim via `providerOptions.google.thoughtSignature` ↔ part `options`/`metadata`.
3. **Gemini tool-schema rules:** every tool needs **≥1 parameter** (empty params → malformed `anyOf` 400), and `success` **must be an object** (`Schema.Struct`) — `functionResponse.response` is a protobuf Struct, scalars 400.
4. **`failureMode: "return"`** makes a handler failure come back to the model as a tool result instead of aborting the turn (our graceful-error behaviour).
5. **Prompt encoding quirks:** there is no `system` option on `generateText` — prepend a `{ role: "system", content }` message to the `Prompt`. Tool-result encoded parts require `providerExecuted`. Field renames vs our `AgentMessage`: `toolCallId↔id`, `toolName↔name`, `input↔params`, `output↔result`, `isError↔isFailure`, `providerOptions↔options`.

---

## Multi-provider (OpenAI + Gemini) + runtime `/model` switch — SHIPPED

**What it does:** the agent loop talks to one provider-agnostic `LanguageModel`; which provider/model backs it is a runtime selection. `/model` lists the live catalogue and switches; the choice persists.

**How it's built:**
- **Core** — `entities/Model.ts` (`Provider`, `ModelSelection`, `ModelInfo`, `parseModel`/`formatModel`/`contextWindowFor`, `DefaultModel`); `ports/ModelRegistry.ts` (`current` / `list` / `select`, `ModelListError`); `Settings.model` (`"<provider>:<modelId>"`).
- **Router** (`adapters/src/llm/router.ts`, `RouterLanguageModelLive`) — a `LanguageModel` whose methods read `ModelRegistry.current` per call and delegate to `GoogleLanguageModel.make` / `OpenAiLanguageModel.make` (built on the fly from the captured client, `Effect.provideService`d in). `ModelLive` bundles router + registry + dynamic `LlmInfo`; requires only `SettingsStore`. Replaces `GoogleLive`.
- **Clients** (`adapters/src/llm/clients.ts`) — both clients with **key-optional** config (missing key never fails layer build; 401s only on use). `hasKey` gates listing.
- **Registry** (`adapters/src/llm/modelRegistry.ts`) — selection from `SettingsStore` (the source of truth); catalogue fetched over **raw HTTP** + parsed defensively (the SDK list schemas mis-decode the live APIs — Google omits `baseModelId`). Filters drop embeddings/image/tts/audio; only key-set providers are queried.
- **CLI** — `main.ts` swaps `GoogleLive` → `ModelLive`; TUI `/model` lists (numbered, cached) + `/model <#|id>` selects, updates the status bar, and warns on a mid-conversation provider switch. `AGENT_MODEL` seeds the default (parsed as `provider:modelId` or bare id), an explicit `/model` choice in `.agent/config.json` wins.

**Caching:** OpenAI — automatic prompt-prefix caching + a stable `prompt_cache_key` (set via `OpenAiLanguageModel.make({ config })`). Gemini — implicit context caching (stable prefix → `cachedContentTokenCount`, surfaced in the gauge). Explicit Gemini `cachedContent` is **not expressible** through `@effect/ai-google@0.14` (it always sends full `contents`, and `Config` omits `contents`/`tools`/`systemInstruction`), so we rely on implicit — this resolves the old "Gemini duplicate-content" open risk (it can't be done cleanly, so we don't).

**Resolved risks:** version skew (`@effect/ai-openai@0.39.2` + `@effect/ai@0.35.0` typecheck + run together fine); mid-conversation switch decided as **apply-forward + hint** (not auto-reset — non-destructive).

---

## Deferred follow-ups

- **Explicit Gemini `cachedContent`** — blocked by `@effect/ai-google@0.14` (always sends full `contents`); implicit caching is live in the meantime.
- **Per-conversation OpenAI `prompt_cache_key`** — currently a stable static key; thread the conversation id to tighten routing.
- **Scoped sub-agent delegation** — `scopedAgentTools`/`runScopedAgent` were deleted (depended on the old `Llm` port); re-add as `@effect/ai` tools whose handlers run a nested loop.
- **Interactive TUI bash confirm** — bash is currently gated only by the `allowBash` flag in the handler; the per-command y/n modal needs re-wiring (e.g. an approval service).
- **Live token streaming** — loop uses `generateText`; switch to `streamText` + map stream parts to events.
- **Compaction** (`onTransformContext` is wired, unused).

---

## Dev / verify

```bash
bun install
bun run typecheck                 # the only correctness gate (no build step)
docker compose up -d              # local Postgres on :5434
bun packages/cli/src/main.ts --mode print --allow-bash "<prompt>"   # one-shot
bun packages/cli/src/main.ts --mode json "<prompt>"                 # JSONL events
```

Env (`.env`, gitignored): `GOOGLE_GENERATIVE_AI_API_KEY` (Gemini) and/or `OPENAI_API_KEY` (OpenAI) — at least one; each optional at startup, only fails if you select that provider. `AGENT_DB_URL` (default `postgres://agent:agent@localhost:5434/agent`), optional `AGENT_MODEL` (`"<provider>:<modelId>"` or bare id).

Smoke test that proves the round-trip: a two-step dependent tool call, e.g. _"read packages/core/package.json, then read packages/core/src/index.ts, and tell me the package name and how many export lines index.ts has."_

---

## OPSEC (non-negotiable)

This tree belongs to the alias **Xandre Reed / @xandreeddev**. Never reference the real human's name in any file, commit, comment, or screenshot. Commit as `Xandre Reed <xandreed@proton.me>` (verify `git config user.email`); **no `Co-Authored-By` trailers**. Never edit/commit from `~/Workspace/xandreed/pi` or `~/Workspace/claw-code` (read-only research). `.env` is gitignored — never commit secrets.
