# @agent/adapters

Concrete implementations of `@agent/core` ports. Side effects live here and nowhere else.

## Layout

One subfolder per port name: `src/llm/` for the `Llm` port, future `src/storage/` for a `Storage` port, etc. Each adapter exports a `Layer` named `<Provider>Live` (e.g., `LlmLive`, future `geminiLive`/`openaiLive` if multiple providers coexist). `src/index.ts` re-exports them.

## Rules

- Each adapter is a `Layer.effect(Port, Effect.gen(function* () { ... return { method: ... } }))`.
- All external promises go through `Effect.tryPromise`, with the `catch` callback mapping the thrown value into the port's tagged error type. Never let an untyped error escape.
- Read configuration via `Config.string` / `Config.number` / etc., not `process.env`. Provide sensible defaults with `Config.withDefault` when reasonable.
- Two adapters for the same port (e.g., `geminiLive` and `openaiLive`) is expected. Picking which one to use is the driver's job, not the adapter's.
- Adapters may depend on `@agent/core` and external SDKs only. Never import from `@agent/application`, `@agent/cli`, `@agent/web`, or other adapters.
