# @xandreed/sdk-core

Pure domain. Runtime dependencies: `effect` + `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`) and nothing else.

## Contents

- `entities/` — Schema-backed types the loop manipulates: `Conversation` (`AgentMessage` union, `Checkpoint`), `AgentContext` (context-tree nodes), `AgentEvent` (the wire event union), `Model` (selections, roles, the generated context-window catalogue), `Settings`, `Scope`, `Skill`, `AgentDefinition`, `AgentHooks`, `Job` (the control-plane submission unit), `Memory`, `Directive`, `Compression`, `Database`, `Prompt`, `Failure`. Pure values; no IO.
- `ports/` — `Context.Tag` services for everything the domain needs from outside: `ConversationStore`, `ContextTreeStore`, `FileSystem`, `Shell`, `Http`, `WebSearch`, `AuthStore`, `SettingsStore`, `ModelRegistry`, `LlmInfo`, `UtilityLlm`, `Approval`, `AuthFlow`. Each port file pairs its tagged errors with the Tag.
- `usecases/` — Effects over the ports: the agent loop (`runAgent.ts`, `agentLoop.ts`, `promptMapping.ts`, `agentPhase.ts`), the **orchestration substrate** lifted here from the CLI (`agentBus.ts` = the Supervisor/bus, `buildScopeRuntime.ts` = sub-agent spawning over the context tree, `codingToolkit.ts` = the coding tools, `discoverScopeTree.ts`, `loadTools.ts`, `schedule.ts`, `staleness.ts`, `parseFrontmatter.ts`), the loop primitives (`runContext.ts`, `tokenBudget.ts`), context management (`handoff.ts`, `compaction.ts`, `compactionContent.ts`), approval (`autoApproval.ts`), and helpers (`generateTitle.ts`). (Workspace-shaped discovery — `loadSkills.ts`, `loadAgents.ts`, `loadMemory.ts`, `discoverInstructionFiles.ts`, `teamAgents.ts` — lives in `@xandreed/code`, not here.)
- `prompts/` — system-prompt strings/functions: `handoff.ts`, `title.ts`, plus the shared fleet/scope pieces lifted from the CLI: `sections.ts` (`subAgentsSection`/`coordinationSection`/`renderAgentsSection`/`renderMemorySection`) and `scopeAgent.ts` (`renderScopeSystemPrompt`). (The root coder prompt `coder.ts` lives in `@xandreed/code`.)
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
- The **`AgentBus`** (`agentBus.ts`) — exported as `type Supervisor = AgentBus` — is the orchestration substrate. It is **NOT a `Context.Tag` port**: it's per-session stateful and carries a per-runtime event sink (`onBusEvent`), so it's threaded as a per-session *value* (`makeAgentBus`), not provided as a single shared Layer.
- Tests are colocated (`*.test.ts`, bun:test). Property-based tests use effect's built-in fast-check integration: `import { Arbitrary, FastCheck } from "effect"`, `Arbitrary.make(schema)` for Schema-derived generators.
