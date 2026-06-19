/**
 * Minimal end-to-end custom agent built from the `@xandreed/sdk-core` primitives.
 *
 * Typecheck:  bunx tsc -p examples/tsconfig.json
 *
 * It defines ONE tool (`roll_dice`), bundles it into an `AgentConfig`, and runs
 * the real agent loop (`runAgent`) against a logged-in provider — no coding
 * toolkit, no scope runtime, no sub-agents. The smallest thing that is still a
 * real agent.
 *
 * Run it (needs a credential in ~/.efferent/auth.json — add one in the TUI with
 * `:login`, or point at a fresh hermetic home):
 *
 *   bun examples/diceAgent.ts
 *
 * The four "context headroom" tactics connect here too:
 *   1+2  append-time tool-result clipping + reversible markers — automatic in
 *        the loop, gated only by `Settings.toolResultMaxTokens`.
 *   3    fast-tier digests — provided by the `UtilityLlmLive` line below; drop
 *        it and oversized clips degrade to plain markers. `onHelperUsage`
 *        accounts the spend.
 *   4    threshold auto-fold — NOT automatic; a driver calls `shouldAutoHandoff`
 *        + `createHandoff` at a turn boundary (see packages/code submit.ts).
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

// ── 1. A tool: Tool.make with an OBJECT `success`, a shared `failure`, and ──
//      `failureMode: "return"` so a handler failure comes back to the model as
//      a tool RESULT instead of aborting the turn.
const Failure = Schema.Struct({ error: Schema.String, message: Schema.String })

const Roll = Tool.make("roll_dice", {
  description: "Roll an N-sided die and return the result.",
  parameters: {
    sides: Schema.Number.annotations({ description: "Number of sides (>= 2)." }),
  },
  success: Schema.Struct({ value: Schema.Number, sides: Schema.Number }),
  failure: Failure,
  failureMode: "return",
})

// ── 2. A toolkit (one tool here; pass more positionally to Toolkit.make). ──
const toolkit = Toolkit.make(Roll)

// ── 3. The handler layer — binds each tool name to an Effect. This is the seam
//      where runtime deps (cwd, FileSystem, ...) would be injected; here the
//      handler is pure, so it needs none. Provided at the composition root.
const handlerLayer = toolkit.toLayer(
  toolkit.of({
    roll_dice: ({ sides }) =>
      sides < 2
        ? Effect.fail({ error: "BadInput", message: "need >= 2 sides" })
        : Effect.succeed({
            value: 1 + Math.floor(Math.random() * sides),
            sides,
          }),
  }),
)

// ── 4. The AgentConfig: prompt + toolkit. This object IS the "define an agent"
//      contract — the coder agent builds the exact same shape. `Tools` is
//      inferred from the toolkit when passed to `runAgent`.
const config: AgentConfig<typeof toolkit extends Toolkit.Toolkit<infer T> ? T : never> = {
  key: "dice-agent",
  prompt: {
    name: "dice",
    version: "1.0.0",
    text: "You are a dice assistant. Use the roll_dice tool whenever asked to roll.",
  },
  toolkit,
}

// ── 5. Hooks (optional) — observe/steer the loop. onBeforeToolCall returns a
//      decision ({ action: "continue" } | { action: "block", reason });
//      onHelperUsage accounts fast-tier headroom digests.
const hooks: AgentHooks = {
  onBeforeToolCall: (e) =>
    Effect.as(Effect.log(`-> ${e.toolName}`), { action: "continue" } as const),
  onHelperUsage: (e) =>
    Effect.log(`fast-tier digest used ${e.usage.totalTokens} tok`),
}

// ── 6. Run it, providing the toolkit handlers at the edge. ──
const program = Effect.gen(function* () {
  const cid = yield* Schema.decodeUnknown(ConversationId)(crypto.randomUUID())
  const result = yield* runAgent(config, cid, "Roll a 20-sided die.", hooks).pipe(
    Effect.provide(handlerLayer),
  )
  yield* Effect.logInfo(result.finalText)
})

// ── 7. Composition root: the layers runAgent's environment needs.
//      Required: ConversationStore (in StoresLive) + SettingsStore +
//      LanguageModel (ModelLive). UtilityLlm is optional (headroom digests).
//      StoresLive's SQLite store needs platform FileSystem/Path — BunContext
//      supplies those (same as the real CLI's main.ts).
const AppLive = Layer.mergeAll(
  StoresLive, // ConversationStore (+ ContextTreeStore) — SQLite by default
  ModelLive, // LanguageModel router (needs AuthStore + SettingsStore)
  UtilityLlmLive.pipe(
    Layer.provide(ModelRegistryLive),
    Layer.provide(FetchHttpClient.layer),
  ),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      LocalAuthStoreLive, // creds from ~/.efferent/auth.json
      LocalSettingsStoreLive.pipe(Layer.provide(LocalFileSystemLive)),
    ),
  ),
  Layer.provideMerge(BunContext.layer), // platform FileSystem / Path / etc.
)

BunRuntime.runMain(program.pipe(Effect.provide(AppLive)))
