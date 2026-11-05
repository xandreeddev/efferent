import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  harnessCodeOf,
  isHarnessError,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { Turn, TurnError, TurnOutcome, TurnRunner } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"
import { Greeter, Unlisted } from "./testing.port.js"

/* ── a tool that reads a process-lifetime host service ── */

const Greet = Tool.make("greet", {
  description: "Greet someone by name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const greeting = defineCapability({
  id: "test-greeting", version: "1",
  tools: [defineTool({ tool: Greet, requires: [Greeter], handler: ({ name }) => Greeter.pipe(Effect.map((greeter) => greeter.greet(name))) })],
  skills: [defineSkill({ id: "greeting", summary: "Greet people.", tools: [Greet.name], always: true })],
})
const greeter = Context.make(Greeter, { greet: (name: string) => `Hello, ${name}.` })

/* ── a scripted model: greet, then answer with what the tool returned ── */

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 1 } }
const scripted = Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<string>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => Ref.modify(seen, (all): [number, ReadonlyArray<string>] => [all.length, [...all, JSON.stringify(options.prompt.content)]]).pipe(
      Effect.map((index) => (index === 0
        ? [{ type: "tool-call", id: "c1", name: Greet.name, params: { name: "Ada" } }, { type: "finish", reason: "tool-calls", usage }]
        : [{ type: "text", text: "greeted" }, { type: "finish", reason: "stop", usage }]) as never)),
    streamText: () => Stream.die("not scripted") as never,
  })
  return { seen, model }
})

const conversation = ConversationId.make("00000000-0000-4000-8000-0000000000a1")
const plugins = [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin]
const base = { plugins, capabilities: [greeting], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 4 } } satisfies AgentConfig

/** A turn's input over a fresh in-memory session, with the model, the Sessions and nothing else in its services. */
const freshTurn = Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  yield* sessions.create({ owner: "test", id: conversation })
  const { seen, model } = yield* scripted
  const input = {
    turn: { session: { id: conversation, owner: "test" }, userMessage: new UserMessage({ text: "greet Ada" }), runId: RunId.make("run-1") },
    services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
  }
  return { input, seen }
})

/** `use`: the turn's tools selected, one run of the loop, its text the reply. */
const run = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({})),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: result.outcome === "waiting" ? Option.none() : Option.some(result.text) })),
  Effect.orDie,
)

/** Holds an effect to needing nothing: the line does not compile when it still requires a service. */
const requiresNothing = <A, E>(effect: Effect.Effect<A, E>) => effect

describe("Agent.define's services", () => {
  test("keep their type: the agent is an Agent of them, and is still an Agent and a TurnRunner", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    // A real context, as the host built it, without a cast.
    const agent = yield* Agent.define({ ...base, services: greeter })
    const typed: Agent<Greeter> = agent
    const erased: Agent = agent
    const runner: TurnRunner = agent
    // An agent defined without services is an Agent of none.
    const bare: Agent<never> = yield* Agent.define(base)
    // @ts-expect-error -- an agent of Greeter is given one: naming it without `services` does not compile.
    const claimed = Agent.define<Greeter>(base)
    expect([typed, erased, runner, bare].every((value) => value === agent || value === bare)).toBe(true)
    expect(Effect.isEffect(claimed)).toBe(true)
  }))))

  test("a turn's use reads them without providing them again; one it reads beside them stays required", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const agent = yield* Agent.define({ ...base, services: greeter })
    const greetedByUse = (turn: Turn) => Greeter.pipe(Effect.flatMap((greeter) => run(turn).pipe(
      Effect.map((outcome): TurnOutcome => ({ ...outcome, reply: Option.map(outcome.reply, (text) => `${text}; ${greeter.greet("host")}`) })))))
    const { input } = yield* freshTurn
    const turn = yield* requiresNothing(agent.turn(input, greetedByUse))
    expect([turn.outcome, turn.reply]).toEqual(["completed", Option.some("greeted; Hello, host.")])

    const alsoUnlisted = (): Effect.Effect<TurnOutcome, TurnError, Greeter | Unlisted> => Effect.all([Greeter, Unlisted], { concurrency: 1 }).pipe(
      Effect.map(([greeter, unlisted]): TurnOutcome => ({ outcome: "completed", reply: Option.some(greeter.greet(unlisted.label)) })))
    const unlisted: Effect.Effect<unknown, unknown, Unlisted> = agent.turn(input, alsoUnlisted)
    // @ts-expect-error -- Unlisted is not among the agent's services, so the turn still requires it.
    requiresNothing(unlisted)

    // Services that may be absent (an optional spread) make an agent of none: its turns require what `use` reads.
    const maybe = (given: boolean) => Agent.define({ ...base, ...(given ? { services: greeter } : {}) })
    const unsure = yield* maybe(true)
    // @ts-expect-error -- that agent may not have been given Greeter, so the turn still requires it.
    requiresNothing(unsure.turn(input, greetedByUse))
  }))))

  test("a tool reads one at run time: the tool's result reaches the model", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const agent = yield* Agent.define({ ...base, services: greeter })
    const { input, seen } = yield* freshTurn
    const turn = yield* agent.turn(input, run)
    const requests = yield* Ref.get(seen)
    expect([turn.outcome, turn.reply, requests.length]).toEqual(["completed", Option.some("greeted"), 2])
    expect(requests[1]).toContain("Hello, Ada.")
  }))))

  test("a tool whose service the agent was not given still fails at turn open with requires.missing, before any step", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const agent = yield* Agent.define(base)
    const { input, seen } = yield* freshTurn
    const error = yield* Effect.flip(agent.turn(input, run))
    expect([harnessCodeOf(error), isHarnessError(error) ? error.message : "none"]).toEqual([Option.some("requires.missing"), `greet requires ${Greeter.key}`])
    expect(yield* Ref.get(seen)).toEqual([])
  }))))
})
