# @xandreed/sdk-core

Pure domain. Runtime dependencies: `effect` + `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`) and nothing else.

## Contents

- `entities/` — Schema-backed types the loop manipulates: `Conversation` (`AgentMessage` union, `Checkpoint`), `AgentContext` (context-tree nodes), `Model` (selections, roles, the generated context-window catalogue), `Settings`, `Scope`, `Skill`, `AgentHooks`. Pure values; no IO.
- `ports/` — `Context.Tag` services for everything the domain needs from outside: `ConversationStore`, `ContextTreeStore`, `FileSystem`, `Shell`, `Http`, `WebSearch`, `AuthStore`, `SettingsStore`, `ModelRegistry`, `LlmInfo`, `UtilityLlm`, `Approval`, `AuthFlow`. Each port file pairs its tagged errors with the Tag.
- `usecases/` — Effects over the ports: the agent loop (`runAgent.ts`, `agentLoop.ts`), the coding toolkit (`codingToolkit.ts`), prompt⇄message mapping (`promptMapping.ts`), sub-agent spawning over the context tree (`buildScopeRuntime.ts`, `runContext.ts`, `tokenBudget.ts`, `folderLock.ts`, `staleness.ts`), context management (`handoff.ts`, `compaction.ts`, `compactionContent.ts`), approval (`autoApproval.ts`), discovery (`loadSkills.ts`, `discoverScopeTree.ts`, `discoverInstructionFiles.ts`), and helpers (`generateTitle.ts`).
- `prompts/` — system-prompt strings/functions: `coder.ts`, `handoff.ts`, `title.ts`.
- `src/index.ts` — the public surface; everything other packages import comes through here.

## Rules

- Never import from `@xandreed/sdk-adapters` or `@xandreed/code`.
- No provider SDKs, no IO libraries — the only SDK allowed is `@effect/ai` (provider-agnostic). Provider packages (`@effect/ai-google`, `@effect/ai-openai`, `@effect/ai-anthropic`) live in `adapters`. If a use case needs a capability, declare a port.
- Pure standard-lib helpers from `node:path` are allowed (string-only — no filesystem access).
- Schema imports use `import { Schema } from "effect"`.
- Tags carry a fully-qualified string ID: `Context.Tag("@xandreed/sdk-core/FileSystem")`.

## Conventions

- camelCase for files that export functions (`runAgent.ts`); PascalCase for files that export types or `Context.Tag` classes (`FileSystem.ts`).
- An `AgentConfig<Tools>` bundles a system prompt with an `@effect/ai` `Toolkit`; `runAgent` takes one — the driver decides which.
- Tests are colocated (`*.test.ts`, bun:test). Property-based tests use effect's built-in fast-check integration: `import { Arbitrary, FastCheck } from "effect"`, `Arbitrary.make(schema)` for Schema-derived generators.
