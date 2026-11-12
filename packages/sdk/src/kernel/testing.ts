import { Context, Effect, Layer, Ref, Result, Stream } from "effect"
import type { Schema } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import type { Prompt, Response } from "effect/ai"
import { Core, inspectionOf, kernel, Sessions } from "@xandreed/core/kernel"
import { Loop } from "./contracts/loop/loop.port.js"
import { requestsOf } from "./contracts/loop/request.entity.functions.js"
import { settings } from "./contracts/loop/settings.adapter.js"
import type { EventDefinition, JournalStorage, KernelEvent, NewSessionInput, SessionId } from "@xandreed/core/kernel"
import type { Settings } from "./contracts/loop/settings.port.js"
import type { Memory } from "./contracts/memory/memory.port.js"
import { inProcessJournal, sessions, stepLoop, windowMemory } from "./index.js"
import type { InvalidBudget, SessionsOptions } from "./index.js"

/*
 * Scaffolding for the kernel's tests: scripted models (no provider, no
 * network), the stock stack composed as a host composes it, a handle on a
 * built stack, and a listener that writes down what `Core` publishes.
 */

const usage = { inputTokens: { total: 12, uncached: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }

/** The system text the tests' agents are set up with. */
export const SYSTEM = "You are a friendly tutor."

/** A model's whole answer as a stream of parts: `pieces`, one text delta each. */
export const answer = (...pieces: ReadonlyArray<string>): Stream.Stream<Response.StreamPartEncoded> => Stream.fromIterable<Response.StreamPartEncoded>([
  { type: "text-start", id: "t" },
  ...pieces.map((delta) => ({ type: "text-delta" as const, id: "t", delta })),
  { type: "text-end", id: "t" },
  { type: "finish", reason: "stop", usage },
])

/** What a scripted model was sent, call by call: each message's role and text. */
export type Received = ReadonlyArray<ReadonlyArray<{ readonly role: string; readonly text: string }>>

const received = (prompt: Prompt.Prompt): Received[number] =>
  prompt.content.map((message) => ({
    role: message.role,
    text: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join(""),
  }))

/** A model that answers call `n` (from 0) with `answerOf(n)`, as a layer, with what it was sent. */
export const scripted = (answerOf: (call: number) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>) => Effect.gen(function* () {
  const prompts = yield* Ref.make<Received>([])
  const model = yield* LanguageModel.make({
    generateText: () => Effect.die("the scripted model only streams"),
    streamText: (options) => Stream.unwrap(Ref.modify(prompts, (all) => [answerOf(all.length), [...all, received(options.prompt)]] as const)),
  })
  return { model: Layer.succeed(LanguageModel.LanguageModel, model), received: Ref.get(prompts) }
})

/** A model that streams `pieces` as its answer to every call. */
export const answering = (...pieces: ReadonlyArray<string>) => scripted(() => answer(...pieces))

/** A model that answers call `n` (from 0) with `Reply n+1.`. */
export const counting = scripted((call) => answer(`Reply ${call + 1}.`))

/** The error of a model that is down. */
export const modelDown = AiError.make({ module: "Scripted", method: "streamText", reason: new AiError.UnknownError({ description: "the scripted model is down" }) })

/** What the parts of a test agent may need: everything below memory and the loop. */
type Below = Core | Settings | Sessions | JournalStorage | LanguageModel.LanguageModel

/** The parts of a test agent a test may replace; the stock ones where it leaves them out. */
export interface Parts<EM, EL, EX> {
  readonly system?: string
  readonly sessions?: SessionsOptions
  readonly memory?: Layer.Layer<Memory, EM, Below>
  readonly loop?: Layer.Layer<Loop, EL, Below | Memory>
  /** Plugins that only listen, built right after the kernel and before every other part: `inOrder` sequences several. */
  readonly extras?: Layer.Layer<never, EX, Core | Settings>
}

/** Several layers that only listen, built one after another in the order given, so their listeners register in that order. */
export const inOrder = <E>(...layers: ReadonlyArray<Layer.Layer<never, E, Core | Settings>>): Layer.Layer<never, E, Core | Settings> =>
  layers.reduce<Layer.Layer<never, E, Core | Settings>>((built, next) => next.pipe(Layer.provideMerge(built)), Layer.empty)

/** The parts built once and shared by the stacks above them: the kernel, a journal kept in the process, the session plugin and the settings, over the model. */
export const base = (model: Layer.Layer<LanguageModel.LanguageModel>, parts: { readonly system?: string; readonly sessions?: SessionsOptions } = {}) =>
  sessions(parts.sessions).pipe(
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(settings({ system: parts.system ?? SYSTEM })),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )

/** The stock agent, composed as a host composes it, with the parts a test replaces. */
export const stack = <EM = never, EL = never, EX = never>(model: Layer.Layer<LanguageModel.LanguageModel>, parts: Parts<EM, EL, EX> = {}) => {
  const loop: Layer.Layer<Loop, EL, Below | Memory> = parts.loop ?? stepLoop
  const memory: Layer.Layer<Memory, EM | InvalidBudget, Below> = parts.memory ?? windowMemory({ budgetTokens: 3000 })
  const extras: Layer.Layer<never, EX, Core | Settings> = parts.extras ?? Layer.empty
  return loop.pipe(
    Layer.provideMerge(memory),
    Layer.provideMerge(sessions(parts.sessions)),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(extras),
    Layer.provideMerge(settings({ system: parts.system ?? SYSTEM })),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
}

/**
 * A stack built in the scope, with what a test calls on it: a test's own
 * shorthand, not a handle the kernel ships. `send` is the loop's `run`,
 * `inspect` the session read, folded and its requests resolved
 * (`inspectionOf` and `requestsOf`), `events` the
 * host's stream of `Core`.
 */
export const open = <E>(layer: Layer.Layer<Core | Sessions | Loop, E>) => Effect.map(Layer.build(layer), (built) => {
  const core = Context.get(built, Core)
  const sessionsOf = Context.get(built, Sessions)
  const loop = Context.get(built, Loop)
  return {
    core,
    loop,
    createSession: (input: NewSessionInput) => sessionsOf.create(input),
    send: (session: SessionId, message: string) => loop.run({ session, message }),
    inspect: (session: SessionId) => Effect.flatMap(sessionsOf.read(session), (journal) => Effect.fromResult(
      Result.flatMap(inspectionOf(journal), (inspection) => Result.map(requestsOf(journal.events), (requests) => ({ ...inspection, requests }))),
    )),
    events: core.events,
  }
})

/**
 * A plugin that writes down, in order, every event of the given
 * definitions as `Core` publishes it. It waits, so what it has seen when a
 * turn returns is everything published during the turn.
 */
export const recording = (definitions: ReadonlyArray<EventDefinition<Schema.Json>>) => Effect.gen(function* () {
  const seen = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
  const layer = Layer.effectDiscard(Effect.gen(function* () {
    const core = yield* Core
    yield* Effect.forEach(definitions, (definition) =>
      core.on(definition, (event) => Ref.update(seen, (all) => [...all, event]), { wait: true, name: "recorder" }), { concurrency: 1, discard: true })
  }))
  return { layer, seen: Ref.get(seen), names: Effect.map(Ref.get(seen), (all) => all.map((event): string => event.name)) }
})
