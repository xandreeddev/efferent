import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Stream } from "effect"
import type { Scope } from "effect"
import { LanguageModel } from "@effect/ai"
import {
  cacheKeyOf,
  ContributionsLive,
  guardTurn,
  openTurnTools,
  stackPlugins,
  TurnLive,
  turnConformance,
  TurnMemory,
  turnOf,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import type { HarnessError, Turn, TurnInput, TurnOutcome, TurnServices } from "@xandreed/core"
import { StepLoopLive } from "@xandreed/plugin-agent-loop"
import { MemoryDigestLive } from "@xandreed/plugin-memory-digest"
import { MemoryLogLive } from "@xandreed/plugin-memory-log"
import { MemoryWindowLive } from "@xandreed/plugin-memory-window"
import { ToolDiscoveryLive } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import { goldenConfig, goldenHost, runGolden } from "./agent.golden.test.js"

/**
 * The golden agent composed by hand from the typed plugin layers and the
 * turn's public pieces, with no plugin graph: the runtime plugins are one
 * stack built once; per turn, the digester is built over the turn's
 * services, then TurnLive, the host's layer and the body.
 */
const composed: Effect.Effect<Pick<Agent, "turn">, HarnessError, Scope.Scope> = Effect.gen(function* () {
  const runtime = yield* Layer.build(ContributionsLive(goldenHost).pipe(
    stackPlugins(MemoryLogLive()),
    stackPlugins(MemoryWindowLive({ digestOnWriteChars: 1 })),
    stackPlugins(ToolDiscoveryLive()),
    stackPlugins(StepLoopLive),
  ))
  const turn = <A = never, E = never, R = never>(input: TurnInput<A, E>, use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>) => {
    const body = Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      yield* openTurnTools
      return yield* use(yield* turnOf({ limits: { streaming: false, maxSteps: 6 }, cacheKey: cacheKeyOf("golden", input.conversation) }))
    })
    const scoped = body.pipe(guardTurn, Effect.scoped)
    const hosted = input.layer === undefined ? scoped : scoped.pipe(Effect.provide(input.layer as Layer.Layer<A, E>))
    return hosted.pipe(
      Effect.provide(TurnLive({ conversation: input.conversation, runId: input.runId, userMessage: input.userMessage, journal: input.journal, system: "GOLDEN system prefix." })),
      Effect.provide(MemoryDigestLive()),
      Effect.provide(input.services),
      Effect.provide(runtime),
    ) as Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>
  }
  return { turn }
})

describe("a turn composed by hand", () => {
  test("from the typed layers and the turn's steps, it reproduces the golden conversation", async () => {
    const [byHand, byAgent] = await Effect.runPromise(Effect.all([runGolden(composed), runGolden(Agent.define(goldenConfig))]))
    const golden = await Bun.file(`${import.meta.dir}/../golden/agent-turn.json`).json()
    expect(JSON.parse(JSON.stringify(byHand))).toEqual(golden)
    expect(JSON.parse(JSON.stringify(byHand))).toEqual(JSON.parse(JSON.stringify(byAgent)))
  })
})

/** The turn services the golden agent requires; the conformance turns never call them. */
const unused = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 } })),
}))
const services = Effect.map(LanguageModel.make({
  generateText: () => Effect.die("not called") as never,
  streamText: () => Stream.die("not called") as never,
}), (model) => Context.merge(Context.make(LanguageModel.LanguageModel, model), unused))

const runners: ReadonlyArray<readonly [string, Effect.Effect<Pick<Agent, "turn">, HarnessError, Scope.Scope>]> = [
  ["Agent.turn", Agent.define(goldenConfig)],
  ["the composition by hand", composed],
]
runners.map(([name, runner]) => describe(`${name} conforms to the turn contract`, () => {
  const checks = turnConformance(runner, Effect.runSync(services))
  checks.map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.either(check.run))
    expect(exit._tag === "Left" ? exit.left.message : "ok").toBe("ok")
  }))
}))
