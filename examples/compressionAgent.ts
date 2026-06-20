/**
 * Customizing context compression with a `CompressionPolicy`.
 *
 * Compression ("compaction") is a property of the agent, not a hardcoded loop step:
 * `AgentConfig.compression`. Omit it and you get the SDK default
 * (`Compaction.default()` — cache-safe, append-time tool-result clipping). This
 * example sets a custom policy and exercises it with a tool that returns a large
 * payload, so the clip + reversible marker actually fire.
 *
 *   - `Compaction.default()`           the default (what you get with no policy)
 *   - `Compression.none`             disable compression entirely
 *   - `Compression.pipeline(...)`    run tail compressors in sequence
 *   - `Compression.when(pred, step)` apply a compressor only when a budget holds
 *
 * Run it (needs a credential in ~/.efferent/auth.json — add one with `:login`):
 *
 *   bun examples/compressionAgent.ts
 */
import { Tool, Toolkit } from "@effect/ai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import {
  Compression,
  ConversationId,
  Compaction,
  runAgent,
  type AgentConfig,
  type AgentHooks,
  type CompressionPolicy,
} from "@xandreed/sdk-core"
import {
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  ModelLive,
  ModelRegistryLive,
  StoresLive,
  UtilityLlmLive,
} from "@xandreed/sdk-adapters"

const Failure = Schema.Struct({ error: Schema.String, message: Schema.String })

// A tool that returns a deliberately large blob, to exercise tail compression.
const FetchLogs = Tool.make("fetch_logs", {
  description: "Fetch the last N lines of a (synthetic) build log.",
  parameters: {
    lines: Schema.Number.annotations({ description: "How many lines to return." }),
  },
  success: Schema.Struct({ log: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

const toolkit = Toolkit.make(FetchLogs)

const handlerLayer = toolkit.toLayer(
  toolkit.of({
    fetch_logs: ({ lines }) =>
      Effect.succeed({
        log: Array.from(
          { length: Math.max(1, lines) },
          (_, i) => `[build] step ${i + 1}: compiled module-${i + 1}.ts ok in ${i % 7}ms`,
        ).join("\n"),
      }),
  }),
)

// ── A custom policy: only clip when the per-result budget is tight, using the
//    SDK's compaction engine as the step. Swap for `Compression.none` to disable,
//    or `Compaction.default()` for the standard behaviour. The policy is inherited
//    by any sub-agents this agent spawns.
const compression: CompressionPolicy = {
  tail: Compression.when((budget) => budget.maxChars < 20_000, Compaction.toolResults()),
}

const config: AgentConfig<typeof toolkit extends Toolkit.Toolkit<infer T> ? T : never> = {
  key: "compression-agent",
  prompt: {
    name: "log-reader",
    version: "1.0.0",
    text: "Use fetch_logs to retrieve build logs, then summarize what happened.",
  },
  toolkit,
  compression,
}

// Typed (empty) hooks pin runAgent's requirements to `never` (see calcAgent.ts).
const hooks: AgentHooks = {}

const program = Effect.gen(function* () {
  const cid = yield* Schema.decodeUnknown(ConversationId)(crypto.randomUUID())
  const result = yield* runAgent(
    config,
    cid,
    "Fetch the last 600 lines of the build log and tell me if every step compiled.",
    hooks,
  ).pipe(Effect.provide(handlerLayer))
  yield* Effect.logInfo(result.finalText)
})

const AppLive = Layer.mergeAll(
  StoresLive,
  ModelLive,
  UtilityLlmLive.pipe(
    Layer.provide(ModelRegistryLive),
    Layer.provide(FetchHttpClient.layer),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalAuthStoreLive,
      LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
    ),
  ),
  Layer.provideMerge(BunContext.layer),
)

BunRuntime.runMain(program.pipe(Effect.provide(AppLive)))
