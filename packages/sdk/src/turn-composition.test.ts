import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Option, Stream } from "effect"
import type { Scope } from "effect"
import { LanguageModel } from "effect/ai"
import {
  cacheKeyOf,
  CapabilitiesLive,
  guardTurn,
  HarnessError,
  Sessions,
  openTurnTools,
  stackPlugins,
  TurnLive,
  turnConformance,
  TurnMemory,
  turnOf,
  SessionLogMemoryLive,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import type { Turn, TurnInput, TurnOutcome, TurnServices, TurnWriter } from "@xandreed/core"
import { StepLoopLive } from "@xandreed/plugin-agent-loop"
import { MemoryDigestLive } from "@xandreed/plugin-memory-digest"
import { MemoryWindowLive } from "@xandreed/plugin-memory-window"
import { ToolDiscoveryLive } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { Agent } from "./agent.adapter.js"
import { expectGolden, goldenConfig, goldenHost, goldenTexts, runGolden } from "./agent.golden.test.js"

/**
 * The golden agent composed by hand from the typed plugin layers and the
 * turn's public pieces, with no plugin graph: the runtime plugins are one
 * stack built once; per turn, the turn is begun with the Sessions of the
 * turn's services, the digester is built over them, then TurnLive, the
 * host's layer and the body; the turn is ended with the outcome.
 */
const composed: Effect.Effect<Pick<Agent, "turn">, HarnessError, Scope.Scope> = Effect.gen(function* () {
  const runtime = yield* Layer.build(CapabilitiesLive(goldenHost).pipe(
    stackPlugins(MemoryWindowLive({ digestOnWriteChars: 1 })),
    stackPlugins(ToolDiscoveryLive()),
    stackPlugins(StepLoopLive),
  ))
  const turn = <A = never, E = never, R = never>(input: TurnInput<A, E>, use: (turn: Turn) => Effect.Effect<TurnOutcome, HarnessError, R>) => Effect.scoped(Effect.gen(function* () {
    const writer: TurnWriter = "admitted" in input.turn ? input.turn : yield* Effect.flatMap(Effect.service(Sessions), (sessions) => {
      const next = input.turn as Exclude<typeof input.turn, TurnWriter>
      return sessions.begin(next.session, { _tag: "User", userMessage: next.userMessage, runId: next.runId, key: next.key ?? next.runId, command: next.command ?? {} })
    }).pipe(Effect.provide(input.services), Effect.mapError((error) => error instanceof HarnessError ? error : new HarnessError({ code: "session.begin", message: error._tag })))
    const body = Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      yield* openTurnTools
      return yield* use(yield* turnOf({ limits: { streaming: false, maxSteps: 6 }, cacheKey: cacheKeyOf("golden", writer.admitted.session.id) }))
    })
    const scoped = body.pipe(guardTurn, Effect.scoped)
    const hosted = input.layer === undefined ? scoped : scoped.pipe(Effect.provide(input.layer as Layer.Layer<A, E>))
    const outcome = yield* hosted.pipe(
      Effect.provide(TurnLive({ turn: writer, system: "GOLDEN system prefix." })),
      Effect.provide(MemoryDigestLive()),
      Effect.provide(input.services),
      Effect.provide(runtime),
    )
    yield* writer.end({ reason: outcome.outcome, failure: Option.none() })
    return outcome
  })) as Effect.Effect<TurnOutcome, HarnessError | E, Exclude<R, A | TurnServices | Scope.Scope>>
  return { turn }
})

describe("a turn composed by hand", () => {
  test("from the typed layers and the turn's steps, it reproduces the golden conversation", async () => {
    const [byHand, byAgent] = await Effect.runPromise(Effect.all([runGolden(composed), runGolden(Agent.define(goldenConfig))]))
    await expectGolden(byHand)
    expect(goldenTexts(byHand)).toEqual(goldenTexts(byAgent))
  })
})

/** The turn services the golden agent requires; the conformance turns never call them. */
const unused = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 } })),
}))
const services = Effect.gen(function* () {
  const model = yield* LanguageModel.make({
    generateText: () => Effect.die("not called") as never,
    streamText: () => Stream.die("not called") as never,
  })
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(SessionLogMemoryLive))), Sessions)
  return Context.merge(Context.merge(Context.make(LanguageModel.LanguageModel, model), unused), Context.make(Sessions, sessions))
})

const runners: ReadonlyArray<readonly [string, Effect.Effect<Pick<Agent, "turn">, HarnessError, Scope.Scope>]> = [
  ["Agent.turn", Agent.define(goldenConfig)],
  ["the composition by hand", composed],
]
runners.map(([name, runner]) => describe(`${name} conforms to the turn contract`, () => {
  const checks = turnConformance(runner, Effect.runSync(Effect.scoped(services)))
  checks.map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
}))
