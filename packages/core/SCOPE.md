---
name: core
description: Owns packages/core/. Pure domain — entities, ports, use cases, prompts. The only runtime dependency is `effect` (+ provider-agnostic `@effect/ai`). No IO, no provider SDKs.
---

## Layering
- `entities/` — Schema-backed types and building blocks: `Conversation` (messages/result), `AgentHooks`, `Skill`, `Scope` (the scope-tree node), `Model`, `Settings`. Pure values; no IO.
- `ports/` — `Context.Tag` services describing capabilities: `ConversationStore`, `FileSystem`, `Shell`, `Http`, `LlmInfo`, `ModelRegistry`, `SettingsStore`. Each port file pairs its tagged errors with the Tag declaration.
- `usecases/` — Functions returning `Effect.Effect<A, E, Port1 | Port2>`. The loop (`agentLoop.ts`, `runAgent.ts`), the `@effect/ai` toolkit (`codingToolkit.ts` — `Tool.make` defs + `makeCodingHandlers`/`codingToolkitLayer`), the scope machinery (`discoverScopeTree.ts`, `buildScopeRuntime.ts`), agent configs (`agentConfig.ts`, `coderAgentConfig.ts`), discovery (`loadSkills.ts`, `discoverInstructionFiles.ts`), and `promptMapping.ts` (our `AgentMessage` ↔ `@effect/ai` `Prompt`/`Response`).
- `prompts/` — System-prompt strings/functions (`coder.ts`: `coderSystemPrompt`, `renderScopeSystemPrompt`, `renderDelegationsSection`).
- `src/index.ts` — public surface; everything other packages import comes through here.

## Hard rules
- Never import from `@agent/adapters`, `@agent/cli`, or `@agent/web`.
- No IO libraries and no provider SDKs — no `fs`, no Bun-only globals, no `@effect/ai-google`/`@effect/ai-openai`. The only SDK allowed is provider-agnostic `@effect/ai` (`LanguageModel`, `Tool`, `Toolkit`, `Prompt`). If a use case needs a capability, declare a port.
- Pure standard-lib helpers from `node:path` and `node:crypto` are allowed (string-only — no filesystem access). Anything that performs IO goes through a port.
- Schema imports use `import { Schema } from "effect"`.
- Tags carry a fully-qualified string ID so Effect's diagnostics stay useful: `Context.Tag("@agent/core/ConversationStore")`.

## Naming
- camelCase for files that export functions (`runAgent.ts`, `codingToolkit.ts`, `buildScopeRuntime.ts`).
- PascalCase for files that export types or `Context.Tag` classes (`FileSystem.ts`, `Scope.ts`).
- `AgentConfig<Tools> = { key; systemPrompt; toolkit }` bundles a system prompt with an `@effect/ai` `Toolkit`. `runAgent` takes one — the driver decides which.

## After editing
- New exports must be re-exported from `src/index.ts` to be visible to other packages.
