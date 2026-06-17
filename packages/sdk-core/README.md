<p align="center">
  <img src="../../assets/logo-sdk.svg" alt="efferent { sdk }" width="520">
</p>

# @xandreed/sdk-core

> The pure domain of the efferent agent — entities, ports, and use cases. Runtime dependencies are **`effect`** and **`@effect/ai`** (provider-agnostic) and nothing else.

This is the inward end of the [ports & adapters](../../README.md) architecture: `cli` → `adapters` → `core`. `core` imports nothing from its siblings — it declares *what* the agent does as Effects over `Context.Tag` ports; the adapters supply *how*.

## What's inside

- **`entities/`** — Schema-backed types the loop manipulates: `Conversation` (the `AgentMessage` union, `Checkpoint`), `AgentContext` (context-tree nodes), `Model` (selections, roles, the generated context-window catalogue), `Settings`, `Scope`, `Skill`, `AgentHooks`. Pure values, no IO.
- **`ports/`** — `Context.Tag` services for everything the domain needs from outside: `ConversationStore`, `ContextTreeStore`, `FileSystem`, `Shell`, `Http`, `WebSearch`, `AuthStore`, `SettingsStore`, `ModelRegistry`, `LlmInfo`, `UtilityLlm`, `Approval`, `AuthFlow`. Each port file pairs its tagged errors with the Tag.
- **`usecases/`** — Effects over the ports: the agent loop (`runAgent.ts`, `agentLoop.ts`), the coding toolkit (`codingToolkit.ts`), prompt⇄message mapping (`promptMapping.ts`), sub-agent spawning over the context tree (`buildScopeRuntime.ts`, `runContext.ts`, `tokenBudget.ts`, `folderLock.ts`, `staleness.ts`), context management (`handoff.ts`, `headroom.ts`), approval (`autoApproval.ts`), discovery (`loadSkills.ts`, `discoverScopeTree.ts`), and helpers.
- **`prompts/`** — system-prompt strings/functions: `coder.ts`, `handoff.ts`, `title.ts`.

## Rules

- Never import from `@xandreed/sdk-adapters` or the CLI. If a use case needs a capability, **declare a port** — the only SDK allowed here is `@effect/ai` (provider packages live in adapters).
- **No `try`/`catch`/`throw`/`.catch()`** in `src/` — error handling is Effect's typed errors (`Effect.fail`, `Effect.catchTag`, …), enforced by `scripts/banTryCatch.ts` in `bun run typecheck`.
- camelCase files export functions; PascalCase files export types / `Context.Tag` classes. Tags carry a fully-qualified id: `Context.Tag("@xandreed/sdk-core/FileSystem")`.

Part of [**efferent**](../../README.md) — a coding agent on Effect.ts + Bun.
