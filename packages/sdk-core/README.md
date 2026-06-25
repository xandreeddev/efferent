<p align="center">
  <img src="../../assets/logo-sdk.svg" alt="efferent { sdk }" width="520">
</p>

# @xandreed/sdk-core

> The pure domain of the efferent agent — entities, ports, and use cases. Runtime dependencies are **`effect`** and **`@effect/ai`** (provider-agnostic) and nothing else.

This is the inward end of the [ports & adapters](../../README.md) architecture: `code` → `sdk-adapters` → `sdk-core`. `sdk-core` imports nothing from its siblings — it declares *what* the agent does as Effects over `Context.Tag` ports; the adapters supply *how*.

## What's inside

- **`entities/`** — Schema-backed types the loop manipulates: `Conversation` (the `AgentMessage` union, `Checkpoint`), `AgentContext` (context-tree nodes), `AgentEvent` (the wire event union), `Model` (selections, roles, the generated context-window catalogue), `Settings`, `Scope`, `Skill`, `AgentDefinition`, `AgentHooks`, `Job` (the control-plane submission unit), `Memory`, `Directive`. Pure values, no IO.
- **`ports/`** — `Context.Tag` services for everything the domain needs from outside: `ConversationStore`, `ContextTreeStore`, `FileSystem`, `Shell`, `Http`, `WebSearch`, `AuthStore`, `SettingsStore`, `ModelRegistry`, `LlmInfo`, `UtilityLlm`, `Approval`, `AuthFlow`. Each port file pairs its tagged errors with the Tag.
- **`usecases/`** — Effects over the ports: the agent loop (`runAgent.ts`, `agentLoop.ts`, `promptMapping.ts`, `agentPhase.ts`); the **orchestration substrate** lifted here from the CLI — `agentBus.ts` (the **Supervisor**, exported as `type Supervisor = AgentBus`; **not** a `Context.Tag` port but a per-session stateful value carrying the event sink, threaded via `makeAgentBus`), `buildScopeRuntime.ts` (sub-agent spawning over the context tree), `codingToolkit.ts` (the coding tools), `discoverScopeTree.ts`, `loadTools.ts`, `schedule.ts`, `staleness.ts`, `parseFrontmatter.ts`; the loop primitives `runContext.ts` + `tokenBudget.ts`; context management (`handoff.ts`, `compaction.ts`, `compactionContent.ts`); approval (`autoApproval.ts`); and helpers (`generateTitle.ts`). (Workspace-shaped discovery — `loadSkills.ts`, `loadAgents.ts`, `loadMemory.ts`, `teamAgents.ts` — lives in `@xandreed/code`.)
- **`prompts/`** — system-prompt strings/functions: `handoff.ts`, `title.ts`, plus the shared fleet/scope pieces lifted from the CLI — `sections.ts` (`subAgentsSection` / `coordinationSection` / `renderAgentsSection` / `renderMemorySection`) and `scopeAgent.ts` (`renderScopeSystemPrompt`). (The root coder prompt `coder.ts` lives in `@xandreed/code`.)

## Rules

- Never import from `@xandreed/sdk-adapters` or the CLI. If a use case needs a capability, **declare a port** — the only SDK allowed here is `@effect/ai` (provider packages live in adapters).
- **No `try`/`catch`/`throw`/`.catch()`** in `src/` — error handling is Effect's typed errors (`Effect.fail`, `Effect.catchTag`, …), enforced by `scripts/banTryCatch.ts` in `bun run typecheck`.
- camelCase files export functions; PascalCase files export types / `Context.Tag` classes. Tags carry a fully-qualified id: `Context.Tag("@xandreed/sdk-core/FileSystem")`.

Part of [**efferent**](../../README.md) — a coding agent on Effect.ts + Bun.
