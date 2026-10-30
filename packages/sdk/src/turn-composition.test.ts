import { describe, expect, test } from "bun:test"
import { Context, Effect, Exit, Layer, Option, Stream, Tracer } from "effect"
import type { Scope } from "effect"
import { LanguageModel } from "effect/ai"
import {
  CapabilitiesLive,
  harnessDefectsAsFailures,
  HarnessError,
  Sessions,
  stackPlugins,
  TurnMemory,
  SessionLogMemoryLive,
  TurnAdmissionOpen,
  turnEndingOf,
  UtilityCompletion,
  UtilityLlm,
} from "@xandreed/core"
import {
  cacheKeyOf,
  guardTurn,
  openTurnTools,
  TurnLive,
  turnOf,
  traceTurn,
} from "@xandreed/core/engine"
import { turnConformance } from "@xandreed/core/conformance"
import type { Turn, TurnBeginError, TurnError, TurnInput, TurnOutcome, TurnResult, TurnServices, TurnWriter } from "@xandreed/core"
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
 * host's layer and the body; the turn is ended with `turnEndingOf` its exit
 * (the outcome, or the failure's code), taken after `harnessDefectsAsFailures`,
 * as `Agent.turn` ends it. Everything after the begin runs under the turn's
 * span (`traceTurn`), as in `Agent.turn`. `change` stands in for a careless
 * host's writer (the kit's self-test); by default the session's own.
 */
const composedWith = (change: (writer: TurnWriter) => TurnWriter = (writer) => writer): Effect.Effect<Pick<Agent, "turn">, HarnessError, Scope.Scope> => Effect.gen(function* () {
  const runtime = yield* Layer.build(CapabilitiesLive(goldenHost).pipe(
    stackPlugins(MemoryWindowLive({ digestOnWriteChars: 1 })),
    stackPlugins(ToolDiscoveryLive()),
    stackPlugins(StepLoopLive),
  ))
  const turn = <A = never, E = never, R = never>(input: TurnInput<A, E>, use: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError, R>) => Effect.scoped(Effect.gen(function* () {
    const writer: TurnWriter = "admitted" in input.turn ? input.turn : change(yield* Effect.flatMap(Effect.service(Sessions), (sessions) => {
      const next = input.turn as Exclude<typeof input.turn, TurnWriter>
      return sessions.begin(next.session, { _tag: "User", userMessage: next.userMessage, runId: next.runId, key: next.key ?? next.runId, command: next.command ?? {} })
    }).pipe(Effect.provide(input.services))) // a refusal is the turn's failure as it is, as under `Agent.turn`
    const body = Effect.gen(function* () {
      yield* (yield* TurnMemory).persistMessage
      yield* openTurnTools
      return yield* use(yield* turnOf({ limits: { streaming: false, maxSteps: 6 }, cacheKey: cacheKeyOf("golden", writer.admitted.session.id) }))
    })
    const scoped = body.pipe(guardTurn, Effect.scoped)
    const hosted = input.layer === undefined ? scoped : scoped.pipe(Effect.provide(input.layer as Layer.Layer<A, E>))
    return yield* Effect.gen(function* () {
      const exit = yield* hosted.pipe(
        Effect.provide(TurnLive({ turn: writer, system: "GOLDEN system prefix." })),
        Effect.provide(MemoryDigestLive()),
        Effect.provide(input.services),
        Effect.provide(runtime),
        // A HarnessError carried as a defect is stored with its own code, as `Agent.turn` stores it.
        harnessDefectsAsFailures,
        Effect.exit,
      )
      if (Exit.isFailure(exit)) {
        yield* writer.end(turnEndingOf(exit)).pipe(Effect.ignore({ log: "Warn", message: "the failed turn's end was not stored" }))
        return yield* Effect.failCause(exit.cause)
      }
      // The inbox items the end leaves waiting are the caller's to drain, as `Agent.turn` returns them.
      const { pending } = yield* writer.end(turnEndingOf(exit))
      return { ...exit.value, pending }
    }).pipe(traceTurn(writer))
  })) as Effect.Effect<TurnResult, TurnBeginError | TurnError | E, Exclude<R, A | TurnServices | Scope.Scope>>
  return { turn }
})
const composed = composedWith()

describe("a turn composed by hand", () => {
  test("from the typed layers and the turn's steps, it reproduces the golden conversation", async () => {
    const [byHand, byAgent] = await Effect.runPromise(Effect.all([runGolden(composed), runGolden(Agent.define(goldenConfig))]))
    await expectGolden(byHand)
    expect(goldenTexts(byHand)).toEqual(goldenTexts(byAgent))
  })

  test("with traceTurn, each turn's spans are under its agent.turn span and carry its ids, as under Agent.turn", async () => {
    const traces = await Effect.runPromise(Effect.forEach([composed, Agent.define(goldenConfig)], (runner) => Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
      yield* runGolden(runner).pipe(Effect.withTracer(tracer))
      return spans
    })))
    const shape = (spans: ReadonlyArray<Tracer.NativeSpan>) => {
      const byId = new Map(spans.map((span) => [span.spanId, span] as const))
      const turnOf = (span: Tracer.NativeSpan): Option.Option<Tracer.NativeSpan> => span.name === "agent.turn" ? Option.some(span)
        : Option.flatMap(Option.flatMap(span.parent, (parent) => Option.fromNullishOr(byId.get(parent.spanId))), turnOf)
      const turns = spans.filter((span) => span.name === "agent.turn")
      // Every engine span is in a turn, and carries that turn's ids.
      const engine = spans.filter((span) => span.name.startsWith("engine.") || span.name.startsWith("tool."))
      const misplaced = engine.filter((span) => Option.match(turnOf(span), {
        onNone: () => true,
        onSome: (turn) => ["efferent.session.id", "efferent.run.id", "efferent.turn"].some((key) => span.attributes.get(key) !== turn.attributes.get(key)),
      }))
      return { turns: turns.map((turn) => [turn.attributes.get("efferent.run.id"), turn.attributes.get("efferent.turn"), turn.attributes.get("efferent.outcome")]), engine: engine.length, misplaced: misplaced.map((span) => span.name) }
    }
    const [byHand, byAgent] = traces.map(shape)
    expect(byHand?.misplaced).toEqual([])
    expect(byHand?.engine).toBeGreaterThan(0)
    expect(byHand?.turns.length).toBeGreaterThan(1)
    expect(byHand).toEqual(byAgent)
  })
})

/** The turn services the golden agent requires; the conformance turns never call them. */
const unused = Context.make(UtilityLlm, UtilityLlm.of({
  complete: () => Effect.succeed(new UtilityCompletion({ text: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })),
}))
const services = Effect.gen(function* () {
  const model = yield* LanguageModel.make({
    generateText: () => Effect.die("not called") as never,
    streamText: () => Stream.die("not called") as never,
  })
  const sessions = Context.get(yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
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

describe("the turn kit catches careless compositions", () => {
  test("one whose writer stores the reply at once, before the turn's end, fails only the closing check", async () => {
    const eager = composedWith((writer) => ({ ...writer, closing: (drafts) => writer.append(drafts) }))
    const failed = await Promise.all(turnConformance(eager, Effect.runSync(Effect.scoped(services))).map(async (check) => {
      const exit = await Effect.runPromise(Effect.result(check.run))
      return exit._tag === "Failure" ? [exit.failure.check] : []
    }))
    expect(failed.flat()).toEqual(["closing"])
  })
})
