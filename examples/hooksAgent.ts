/**
 * Observing and steering the loop with `AgentHooks`.
 *
 * Hooks let the application watch and influence the agent loop without owning it.
 * Every hook is optional and returns an `Effect`. Here we:
 *   - log each turn and each tool call/result (observe), and
 *   - BLOCK a tool call that violates a guardrail (steer) — `onBeforeToolCall`
 *     returns `{ action: "block", reason }`, and the reason is handed back to the
 *     model as a tool result so it can adjust in the same turn.
 *
 * Run it (needs a credential in ~/.efferent/auth.json — add one with `:login`):
 *
 *   bun examples/hooksAgent.ts
 */
import { Tool, Toolkit } from "@effect/ai"
import { FetchHttpClient } from "@effect/platform"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import {
  ConversationId,
  runAgent,
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

const Failure = Schema.Struct({ error: Schema.String, message: Schema.String })

const Roll = Tool.make("roll_dice", {
  description: "Roll an N-sided die.",
  parameters: {
    sides: Schema.Number.annotations({ description: "Number of sides (>= 2)." }),
  },
  success: Schema.Struct({ value: Schema.Number, sides: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

const toolkit = Toolkit.make(Roll)

const handlerLayer = toolkit.toLayer(
  toolkit.of({
    roll_dice: ({ sides }) =>
      Effect.succeed({ value: 1 + Math.floor(Math.random() * sides), sides }),
  }),
)

const config: AgentConfig<typeof toolkit extends Toolkit.Toolkit<infer T> ? T : never> = {
  key: "hooks-agent",
  prompt: {
    name: "dice",
    version: "1.0.0",
    text: "You are a dice assistant. Use roll_dice when asked to roll.",
  },
  toolkit,
}

// ── The hooks. R = never here — they only log + decide. ──
const hooks: AgentHooks = {
  onTurnStart: (e) => Effect.log(`turn ${e.turnIndex} starts (${e.messages.length} msgs)`),

  // Steer: refuse absurd dice. The reason returns to the model as a tool result.
  onBeforeToolCall: (e) => {
    const sides = (e.args as { sides?: number }).sides ?? 0
    if (e.toolName === "roll_dice" && sides > 100) {
      return Effect.as(
        Effect.log(`blocked roll_dice(${sides}) — guardrail`),
        { action: "block", reason: "Dice may have at most 100 sides." } as const,
      )
    }
    return Effect.succeed({ action: "continue" } as const)
  },

  onAfterToolCall: (e) =>
    Effect.log(`${e.toolName} -> ${e.ok ? "ok" : "fail"}: ${JSON.stringify(e.result)}`),

  onAssistantMessage: (e) =>
    e.usage
      ? Effect.log(`assistant used ${e.usage.totalTokens} tokens`)
      : Effect.void,
}

const program = Effect.gen(function* () {
  const cid = yield* Schema.decodeUnknown(ConversationId)(crypto.randomUUID())
  const result = yield* runAgent(
    config,
    cid,
    "Roll a 6-sided die, then try to roll a 500-sided die.",
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
