# @efferent/core

Pure domain. Only runtime dependency: `effect`.

## Contents

- `entities/` — Schema-backed types and the building blocks the loop manipulates: `Conversation`, `Capture`, `AgentTool`, `AgentHooks`. Pure values; no IO.
- `ports/` — `Context.Tag` services describing capabilities the application needs from the outside world: `Llm`, `CaptureStore`, `ConversationStore`, `FileSystem`, `Shell`. Each port file pairs its tagged errors with the Tag declaration.
- `usecases/` — Functions returning `Effect.Effect<A, E, Port1 | Port2>`. The agent loop (`agentLoop.ts`, `runAgent.ts`), tool definitions (`captureTools.ts`, `codingTools.ts`), agent configs (`notesAgentConfig.ts`, `coderAgentConfig.ts`), and the notes-domain workflows (`capture`, `saveCapture`, `getCapture`, `listCaptures`, `deleteCapture`, `renderUi`).
- `prompts/` — System-prompt strings/functions: `notes.ts` (notes assistant), `coder.ts` (coding assistant), `capture.ts` (notes extraction), `renderUi.ts` (HTML rendering).
- `src/index.ts` — Public surface; everything other packages import comes through here.

## Rules

- Never import from `@efferent/adapters`, `@efferent/cli`, or `@efferent/web`.
- No SDK / IO libraries — no `ai`, no `@ai-sdk/*`, no `fs`, no Bun-only globals. If a use case needs a capability, declare a port; do not reach for an SDK directly.
- Pure standard-lib helpers from `node:path` are allowed (string-only — no filesystem access). Anything that performs IO must go through a port.
- Schema imports use `import { Schema } from "effect"`.
- Tags carry a fully-qualified string ID so Effect's diagnostics stay useful: `Context.Tag("@efferent/core/Llm")`.

## Conventions

- camelCase for files that export functions (`runAgent.ts`, `codingTools.ts`).
- PascalCase for files that export types or `Context.Tag` classes (`Llm.ts`, `FileSystem.ts`).
- An `AgentConfig<R> = { key; systemPrompt; tools }` bundles a system prompt with its tool set. `runAgent` takes one — the driver decides which.
