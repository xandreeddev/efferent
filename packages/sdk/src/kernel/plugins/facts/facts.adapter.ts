import { Effect, Layer, Option, Result, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Sessions } from "@xandreed/core/kernel"
import type { InvalidSession, JournalStorageError, SessionId } from "@xandreed/core/kernel"
import { checkedLimit, factFrom, factsNote, factsOf, factToForget, forgotten, learned, MEMORY_BUSY, nextFactId, relevant } from "../../contracts/facts/facts.entity.functions.js"
import { FACT_LIMIT, FACTS_OWNER, FORGET_FACT, REMEMBER_FACT, RememberedFact } from "../../contracts/facts/facts.entity.js"
import type { Fact, FactsOptions } from "../../contracts/facts/facts.entity.js"
import { memoryAmong, memoryJournal } from "../../contracts/facts/facts.usecase.js"
import { questionOf } from "../../contracts/memory/memory.entity.functions.js"
import { Memory } from "../../contracts/memory/memory.port.js"
import { CurrentTurn } from "../../contracts/turn/current-turn.port.js"

/**
 * The memory session (ADR 0014): the journal that holds an agent's facts. It is the first session, by creation,
 * that the plugin owns; with none in the store, one is created, and the store is listed again, so two programs
 * that each created one before either listed again both write to the first. The kernel assumes one writer per
 * store (ADR 0010): a second program that creates its session after the first listed again, under a clock or an
 * id that sorts it first, leaves what the first wrote meanwhile in a session that is not read. A host on a store
 * that outlives its process recovers this session as it recovers its conversation (`Sessions.recover`): a writer
 * that died inside a `rememberFact` leaves its turn open, and only the host knows that the writer is gone.
 *
 * @public
 */
export const memorySession: Effect.Effect<SessionId, InvalidSession | JournalStorageError, Sessions> = Effect.gen(function* () {
  const sessions = yield* Sessions
  const found = memoryAmong(yield* sessions.list)
  if (Option.isSome(found)) return found.value
  const created = yield* sessions.create({ owner: FACTS_OWNER })
  return Option.getOrElse(memoryAmong(yield* sessions.list), () => created)
})

/**
 * The facts that stand, read from the memory session, for a host that writes a wrapper of its own. With no memory
 * session in the store there are none, and none is created: reading stores nothing.
 *
 * @public
 */
export const rememberedFacts: Effect.Effect<ReadonlyArray<Fact>, JournalStorageError, Sessions> = Effect.suspend(() => Effect.map(memoryJournal, factsOf))

/**
 * The tool that remembers a fact across conversations (ADR 0014). It stores the fact in the memory session, a
 * journal of its own, and answers the fact's id. `factTools` holds it and `factHandlers` runs it.
 *
 * @public
 */
export const RememberFact = Tool.make(REMEMBER_FACT, {
  description: `Remember a fact for later conversations: something the user told you that will still matter another day. Returns the fact's id. Do not use it for what matters only in this conversation.`,
  parameters: Schema.Struct({ fact: Schema.String.annotate({ description: `The fact, as one sentence of at most ${FACT_LIMIT} characters that can be read on its own.` }) }),
  success: RememberedFact,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Sessions, CurrentTurn],
})

/**
 * The tool that forgets a fact (ADR 0014): the fact no longer stands, and is sent in no later request.
 *
 * @public
 */
export const ForgetFact = Tool.make(FORGET_FACT, {
  description: "Forget a remembered fact, when the user asks you to or says it is no longer true. Returns what was forgotten.",
  parameters: Schema.Struct({ id: Schema.String.annotate({ description: "The fact's id, as the list of remembered facts gives it, such as f1." }) }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Sessions, CurrentTurn],
})

/**
 * The two tools of an agent that remembers: a host merges them into its own toolkit, `Toolkit.merge(tools,
 * factTools)`, which keeps each tool's type.
 *
 * @public
 */
export const factTools = Toolkit.make(RememberFact, ForgetFact)

/**
 * What a failed call says to the model: a refusal of the tool's own in its words, and a memory session that
 * another turn is writing to in fixed words. Any other failure of the store or the session is a defect, as a
 * tool's failed append is: `callTool` stores it as the call's failed result, and a loop of a host's own sees it.
 */
const said = (error: string | { readonly _tag: string; readonly reason?: string }): Effect.Effect<never, string> =>
  typeof error === "string" ? Effect.fail(error) : error._tag === "SessionRefused" && error.reason === "SessionBusy" ? Effect.fail(MEMORY_BUSY) : Effect.die(error)

/**
 * What the two tools do: each call is one turn on the memory session, which stores the record with the
 * conversation and turn it came from. A text that is no fact, an id no standing fact has and a memory session
 * another turn is writing to are failed results the model reads; a store that fails is a defect.
 *
 * @public
 */
export const factHandlers = factTools.toLayer({
  rememberFact: ({ fact }) => Effect.gen(function* () {
    const sessions = yield* Sessions
    const caller = yield* CurrentTurn
    const text = yield* Effect.fromResult(factFrom(fact))
    return yield* sessions.turn(yield* memorySession, (session) => Effect.gen(function* () {
      const id = nextFactId(yield* session.journal)
      yield* session.append(learned({ id, text, from: { session: caller.id, turn: caller.turn } }))
      return { id }
    }))
  }).pipe(Effect.catch(said)),
  forgetFact: ({ id }) => Effect.gen(function* () {
    const sessions = yield* Sessions
    // Read first, so an id no fact has opens no turn; read again inside the turn, where nothing else writes.
    yield* Effect.fromResult(factToForget(yield* rememberedFacts, id))
    return yield* sessions.turn(yield* memorySession, (session) => Effect.gen(function* () {
      const fact = yield* Effect.fromResult(factToForget(factsOf(yield* session.journal), id))
      yield* session.append(forgotten(fact.id))
      return `Forgot ${fact.id}: ${fact.text}`
    }))
  }).pipe(Effect.catch(said)),
})

/**
 * A wrapper of `Memory` (ADR 0005, ADR 0014): for each request it reads the facts that stand in the memory
 * session and adds up to `limit` of them, last, after the context the memory below returned: those the question
 * shares words with first, then the newest (`relevant`). The question is the user's last message in the
 * conversation's journal. Nothing is stored, and with no fact nothing is added. A limit that is none is refused
 * here, where it is written: it throws, as a definition does.
 *
 * @public
 */
export const withFacts = (options: FactsOptions) => {
  const limit = Result.getOrThrowWith(checkedLimit(options), (problem) => new Error(problem))
  return <E, R>(memory: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R | Sessions> =>
    Layer.effect(Memory, Effect.gen(function* () {
      const below = yield* Memory
      const sessions = yield* Sessions
      return Memory.of({
        context: Effect.fnUntraced(function* (session) {
          const context = yield* below.context(session)
          const facts = yield* Effect.provideService(rememberedFacts, Sessions, sessions)
          const chosen = relevant(facts, questionOf(yield* session.journal), limit)
          return chosen.length === 0 ? context : [...context, { role: "user" as const, content: factsNote(chosen) }]
        }),
      })
    })).pipe(Layer.provide(memory))
}
