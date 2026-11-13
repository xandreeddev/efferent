import { Context, Effect, Layer, Match, Option, Ref, Schema, Stream } from "effect"
import { AiError, LanguageModel, Prompt } from "effect/ai"
import type { Response } from "effect/ai"
import { assistantMessage, Core, inspectionOf, kernel, live, liveEvent, Sessions, userMessage } from "@xandreed/core/kernel"
import type { EventDefinition, JournalStorage, KernelEvent, NewSessionInput, SessionId, Usage } from "@xandreed/core/kernel"
import type { InboxTurnFailure } from "./contracts/inbox/inbox.port.js"
import { Memory } from "./contracts/memory/memory.port.js"
import { inProcessJournal, sessions, windowMemory } from "./index.js"
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

/** A model's stream reported an error part-way: an answer cut by one is no answer. */
export class ModelFailed extends Schema.TaggedError<ModelFailed>()("ModelFailed", { message: Schema.String, cause: Schema.optional(Schema.Defect()) }) {}

/** A message of no text, refused before a turn opens. */
export class EmptyMessage extends Schema.TaggedError<EmptyMessage>()("EmptyMessage", { message: Schema.String }) {}

/** The provider's report, when it counted both what it read and what it wrote. */
const usageOf = (reported: Response.Usage): Option.Option<Usage> =>
  reported.inputTokens.total === undefined || reported.outputTokens.total === undefined
    ? Option.none()
    : Option.some({ inputTokens: reported.inputTokens.total, outputTokens: reported.outputTokens.total, ...(reported.inputTokens.cacheRead === undefined ? {} : { cachedInputTokens: reported.inputTokens.cacheRead }) })

/** A piece of an answer as the tests' turn publishes it, live: what a client would draw. */
export const pieceEvent = liveEvent("test", "piece", { tags: ["ui"], data: Schema.Struct({ text: Schema.String }) })

/** What a turn of the tests runs over: the kernel's events, sessions, memory and a model. */
export type TurnNeeds = Core | Sessions | Memory | LanguageModel.LanguageModel

/** A turn as the tests run one: the host's program for one message, from the message to the answer. */
export type Turn = (session: SessionId, message: string) => Effect.Effect<string, InboxTurnFailure, TurnNeeds>

/**
 * The tests' turn: the kernel has no loop, so the tests run turns the way a
 * host writes its program. One turn per message: open it in a scope, store
 * the message, ask memory for the context, send the system text and the
 * context, publish the answer's pieces live, store the answer with what the
 * provider reported it cost.
 */
export const testTurn = (system: string = SYSTEM): Turn => (conversation, message) => message.trim().length === 0
  ? Effect.fail(new EmptyMessage({ message: "a turn needs a message that is not empty" }))
  : Effect.scoped(Effect.gen(function* () {
    const core = yield* Core
    const turns = yield* Sessions
    const memory = yield* Memory
    const model = yield* LanguageModel.LanguageModel
    type Gathered = { readonly text: string; readonly usage: Option.Option<Usage> }
    const session = yield* turns.open(conversation)
    yield* session.append(userMessage(message))
    const history = yield* memory.context(session)
    const answer = yield* model.streamText({ prompt: Prompt.make([{ role: "system", content: system }, ...history]) }).pipe(
      Stream.runFoldEffect((): Gathered => ({ text: "", usage: Option.none() }), (gathered, part) => Match.value(part).pipe(
        Match.discriminator("type")("text-delta", ({ delta }) => Effect.as(core.publish(live(pieceEvent, session, { text: delta })), { ...gathered, text: gathered.text + delta })),
        Match.discriminator("type")("error", ({ error }) => Effect.fail(new ModelFailed({ message: "the model's stream reported an error", cause: error }))),
        Match.discriminator("type")("finish", ({ usage }) => Effect.succeed({ ...gathered, usage: usageOf(usage) })),
        Match.orElse(() => Effect.succeed(gathered)),
      )),
    )
    yield* session.append(assistantMessage(answer.text, Option.match(answer.usage, { onNone: () => ({}), onSome: (usage) => ({ usage }) })))
    return answer.text
  }))

/** What the parts of a test agent may need: everything below memory. */
type Below = Core | Sessions | JournalStorage | LanguageModel.LanguageModel

/** The parts of a test agent a test may replace; the stock ones where it leaves them out. */
export interface Parts<EM, EX> {
  readonly sessions?: SessionsOptions
  readonly memory?: Layer.Layer<Memory, EM, Below>
  /** Plugins that only listen, built right after the kernel and before every other part: `inOrder` sequences several. */
  readonly extras?: Layer.Layer<never, EX, Core>
}

/** Several layers that only listen, built one after another in the order given, so their listeners register in that order. */
export const inOrder = <E>(...layers: ReadonlyArray<Layer.Layer<never, E, Core>>): Layer.Layer<never, E, Core> =>
  layers.reduce<Layer.Layer<never, E, Core>>((built, next) => next.pipe(Layer.provideMerge(built)), Layer.empty)

/** The parts built once and shared by the stacks above them: the kernel, a journal kept in the process and the session plugin, over the model. */
export const base = (model: Layer.Layer<LanguageModel.LanguageModel>, parts: { readonly sessions?: SessionsOptions } = {}) =>
  sessions(parts.sessions).pipe(
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )

/** The modules a test turn runs over, composed as a host composes them, with the parts a test replaces. */
export const stack = <EM = never, EX = never>(model: Layer.Layer<LanguageModel.LanguageModel>, parts: Parts<EM, EX> = {}) => {
  const memory: Layer.Layer<Memory, EM | InvalidBudget, Below> = parts.memory ?? windowMemory({ budgetTokens: 3000 })
  const extras: Layer.Layer<never, EX, Core> = parts.extras ?? Layer.empty
  return memory.pipe(
    Layer.provideMerge(sessions(parts.sessions)),
    Layer.provideMerge(inProcessJournal()),
    Layer.provideMerge(extras),
    Layer.provideMerge(kernel()),
    Layer.provideMerge(model),
  )
}

/**
 * A stack built in the scope, with what a test calls on it: a test's own
 * shorthand, not a handle the kernel ships. `send` runs `turn` (the tests'
 * own when left out) over the stack, `inspect` reads the session and folds
 * it (`inspectionOf`), `events` is the host's stream of `Core`.
 */
export const open = <E>(layer: Layer.Layer<TurnNeeds, E>, turn: Turn = testTurn()) => Effect.map(Layer.build(layer), (built) => {
  const core = Context.get(built, Core)
  const sessionsOf = Context.get(built, Sessions)
  return {
    core,
    createSession: (input: NewSessionInput) => sessionsOf.create(input),
    send: (session: SessionId, message: string) => Effect.provide(turn(session, message), built),
    inspect: (session: SessionId) => Effect.flatMap(sessionsOf.read(session), (journal) => Effect.fromResult(inspectionOf(journal))),
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
