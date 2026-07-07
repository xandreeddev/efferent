# @xandreed/sdk-core

Pure domain. Runtime dependencies: `effect` + `@effect/ai` (provider-agnostic — `LanguageModel`, `Tool`, `Toolkit`, `Prompt`) and nothing else.

## Contents

- `entities/` — Schema-backed types the loop manipulates: `Conversation` (`AgentMessage` union, `Checkpoint`), `AgentContext` (context-tree nodes), `AgentEvent` (the wire event union), `Model` (selections, roles, the generated context-window catalogue), `Settings`, `Scope`, `Skill`, `AgentDefinition`, `AgentHooks`, `Job` (the control-plane submission unit), `Memory`, `Directive`, `Compression`, `Database`, `Prompt`, `Failure`. Pure values; no IO.
- `ports/` — `Context.Tag` services for everything the domain needs from outside: `ConversationStore`, `ContextTreeStore`, `FileSystem`, `Shell`, `Http`, `WebSearch`, `AuthStore`, `SettingsStore`, `ModelRegistry`, `LlmInfo`, `UtilityLlm`, `Approval`, `AuthFlow`. Each port file pairs its tagged errors with the Tag.
- `usecases/` — Effects over the ports: the agent loop (`runAgent.ts`, `agentLoop.ts`, `promptMapping.ts`, `agentPhase.ts`), the **orchestration substrate** lifted here from the CLI (`agentBus.ts` = the Supervisor/bus, `buildScopeRuntime.ts` = sub-agent spawning over the context tree, `codingToolkit.ts` = the coding tools, `discoverScopeTree.ts`, `loadTools.ts`, `schedule.ts`, `staleness.ts`, `parseFrontmatter.ts`), **workspace-shaped discovery** (`workspaceDiscovery.ts` = the shared ancestor-walk + `.md` asset loader, `loadSkills.ts`, `loadAgents.ts` (+ `parseAgentFile`, Option-returning), `loadMemory.ts`, `discoverInstructionFiles.ts`), the driver seams (`coderAgentConfig.ts`, `eventHooks.ts` = `makeAgentEventHooks`/`makeEventHooks`, `roster.ts` = `stripLeads`), the loop primitives (`runContext.ts`, `tokenBudget.ts`), context management (`handoff.ts`, `compaction.ts`, `compactionContent.ts`), approval (`autoApproval.ts`), and helpers (`generateTitle.ts`). (`teamAgents.ts` — the built-in fleet — stays in `efferent`.)
- `prompts/` — system-prompt strings/functions: `handoff.ts`, `title.ts`, the shared fleet/scope pieces lifted from the CLI: `sections.ts` (`subAgentsSection`/`coordinationSection`/`renderAgentsSection`/`renderMemorySection`) and `scopeAgent.ts` (`renderScopeSystemPrompt`), plus the root coder prompt `coder.ts` (`coderPrompt`/`coderSystemPrompt` — moved here so any driver can build the real coder without the CLI; the web prompt stays in `efferent`).
- `src/index.ts` — the public surface; everything other packages import comes through here.

## Rules

- Never import from `@xandreed/sdk-adapters` or `efferent`.
- No provider SDKs, no IO libraries — the only SDK allowed is `@effect/ai` (provider-agnostic). Provider packages (`@effect/ai-google`, `@effect/ai-openai`, `@effect/ai-anthropic`) live in `adapters`. If a use case needs a capability, declare a port.
- Pure standard-lib helpers from `node:path` are allowed (string-only — no filesystem access).
- Schema imports use `import { Schema } from "effect"`.
- Tags carry a fully-qualified string ID: `Context.Tag("@xandreed/sdk-core/FileSystem")`.

## Conventions

- camelCase for files that export functions (`runAgent.ts`); PascalCase for files that export types or `Context.Tag` classes (`FileSystem.ts`).
- An `AgentConfig<Tools>` bundles a system prompt with an `@effect/ai` `Toolkit`; `runAgent` takes one — the driver decides which.
- The **`AgentBus`** (`agentBus.ts`) — exported as `type Supervisor = AgentBus` — is the orchestration substrate. It is **NOT a `Context.Tag` port**: it's per-session stateful and carries a per-runtime event sink (`onBusEvent`), so it's threaded as a per-session *value* (`makeAgentBus`), not provided as a single shared Layer.
- Tests are colocated (`*.test.ts`, bun:test). Property-based tests use effect's built-in fast-check integration: `import { Arbitrary, FastCheck } from "effect"`, `Arbitrary.make(schema)` for Schema-derived generators.
