---
name: core
description: Owns packages/core/. Pure domain — entities, ports, use cases, prompts. The only runtime dependency is `effect`. No IO, no SDKs.
---

## Layering
- `entities/` — Schema-backed types and building blocks (`Conversation`, `AgentTool`, `AgentHooks`, `Skill`, `ScopedAgent`). Pure values; no IO.
- `ports/` — `Context.Tag` services describing capabilities (`Llm`, `LlmCache`, `LlmInfo`, `LlmFast`, `ConversationStore`, `CaptureStore`, `FileSystem`, `Shell`). Each port file pairs its tagged errors with the Tag declaration.
- `usecases/` — Functions returning `Effect.Effect<A, E, Port1 | Port2>`. Loop (`agentLoop.ts`, `runAgent.ts`, `runScopedAgent.ts`), tool factories (`codingTools.ts`, `captureTools.ts`, `buildScopedCodingTools.ts`, `scopedAgentTools.ts`), agent configs, discovery (`loadSkills.ts`, `discoverScopedAgents.ts`), and the notes-domain workflows.
- `prompts/` — System-prompt strings/functions (`coder.ts`, `notes.ts`, `capture.ts`, `renderUi.ts`).
- `src/index.ts` — public surface; everything other packages import comes through here.

## Hard rules
- Never import from `@agent/adapters`, `@agent/cli`, or `@agent/web`.
- No SDK / IO libraries — no `ai`, no `@ai-sdk/*`, no `fs`, no Bun-only globals. If a use case needs a capability, declare a port; do not reach for an SDK directly.
- Pure standard-lib helpers from `node:path` and `node:crypto` are allowed (string-only — no filesystem access). Anything that performs IO must go through a port.
- Schema imports use `import { Schema } from "effect"`.
- Tags carry a fully-qualified string ID so Effect's diagnostics stay useful: `Context.Tag("@agent/core/Llm")`.

## Naming
- camelCase for files that export functions (`runAgent.ts`, `codingTools.ts`).
- PascalCase for files that export types or `Context.Tag` classes (`Llm.ts`, `FileSystem.ts`, `ScopedAgent.ts`).
- An `AgentConfig<R> = { key; systemPrompt; tools }` bundles a system prompt with its tool set. `runAgent` takes one — the driver decides which.

## After editing
- New exports must be re-exported from `src/index.ts` to be visible to other packages.
