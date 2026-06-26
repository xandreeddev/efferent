/**
 * A multi-tool agent built from `@xandreed/sdk-core`.
 *
 * Where `diceAgent.ts` has one tool, this has two (`add`, `multiply`) in a single
 * `Toolkit` — the only change is passing more tools positionally to `Toolkit.make`
 * and binding one handler per tool name. Everything else (config, loop, composition
 * root) is identical.
 *
 * Run it (needs a credential in ~/.efferent/auth.json — add one in the TUI with
 * `:login`):
 *
 *   bun examples/calcAgent.ts
 */
import { homedir } from "node:os"
import { Tool, Toolkit } from "@effect/ai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import {
  ConversationId,
  runAgent,
  SettingsStore,
  type AgentConfig,
  type AgentHooks,
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

// ── Two tools sharing one failure shape. Each `success` is an object Struct. ──
const Failure = Schema.Struct({ error: Schema.String, message: Schema.String })

const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: {
    a: Schema.Number.annotations({ description: "First addend." }),
    b: Schema.Number.annotations({ description: "Second addend." }),
  },
  success: Schema.Struct({ result: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

const Multiply = Tool.make("multiply", {
  description: "Multiply two numbers.",
  parameters: {
    a: Schema.Number.annotations({ description: "First factor." }),
    b: Schema.Number.annotations({ description: "Second factor." }),
  },
  success: Schema.Struct({ result: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

// ── More tools? Pass them all positionally. ──
const toolkit = Toolkit.make(Add, Multiply)

// ── One handler per tool name. Both are pure, so the layer needs no deps. ──
const handlerLayer = toolkit.toLayer(
  toolkit.of({
    add: ({ a, b }) => Effect.succeed({ result: a + b }),
    multiply: ({ a, b }) => Effect.succeed({ result: a * b }),
  }),
)

const config: AgentConfig<typeof toolkit extends Toolkit.Toolkit<infer T> ? T : never> = {
  key: "calc-agent",
  prompt: {
    name: "calc",
    version: "1.0.0",
    text: "You are a calculator. Use the add and multiply tools to compute answers; never do arithmetic in your head.",
  },
  toolkit,
}

// A typed (empty) hooks value pins runAgent's requirements to `never` — without
// it, the omitted `extraHooks` leaves the type parameter uninferred.
const hooks: AgentHooks = {}

const program = Effect.gen(function* () {
  // Load settings so the agent uses YOUR configured model (the one `:login`
  // pinned in ~/.efferent/config.json, or $EFFERENT_MODEL) — not the default.
  yield* (yield* SettingsStore).load(process.cwd(), homedir())
  const cid = yield* Schema.decodeUnknown(ConversationId)(crypto.randomUUID())
  const result = yield* runAgent(
    config,
    cid,
    "What is (12 + 30) multiplied by 7?",
    hooks,
  ).pipe(Effect.provide(handlerLayer))
  yield* Effect.logInfo(result.finalText)
})

// ── Same composition root as diceAgent.ts. ──
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
