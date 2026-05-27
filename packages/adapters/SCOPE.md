---
name: adapters
description: Owns packages/adapters/. Concrete implementations of @agent/core ports — IO and SDKs live here and nowhere else.
---

## Layout
One subfolder per port name: `src/llm/` for LLM ports, `src/conversationStore/` for `ConversationStore`, `src/captureStore/` for `CaptureStore`, `src/database/`, `src/fileSystem/`, `src/shell/`. Each adapter exports a `Layer` named `<Provider>Live` (e.g. `GeminiLive`, `GeminiFastLive`, `LocalFileSystemLive`, `PostgresConversationStoreLive`). `src/index.ts` re-exports them.

## Hard rules
- Each adapter is a `Layer.effect(Port, Effect.gen(function* () { ... return { method: ... } }))`.
- All external promises go through `Effect.tryPromise`, with the `catch` callback mapping the thrown value into the port's tagged error type. Never let an untyped error escape.
- Read configuration via `Config.string` / `Config.redacted` / `Config.number`, not `process.env`. Provide sensible defaults with `Config.withDefault` when reasonable.
- Two adapters for the same port (e.g. `GeminiLive` and a future `OpenAiLive`) is expected. Picking which one to use is the driver's job, not the adapter's.
- Adapters may depend on `@agent/core` and external SDKs only. Never import from `@agent/cli`, `@agent/web`, or other adapters.

## Bundle pattern (when one provider supplies multiple ports)
The Gemini smart-tier serves `Llm`, `LlmCache`, and `LlmInfo` from a single shared internal services tag — `GeminiServices` — so setup runs once regardless of how many of the three ports the caller wires. See `src/llm/gemini.ts` for the pattern.
