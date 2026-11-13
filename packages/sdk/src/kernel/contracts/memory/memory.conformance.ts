import { Effect, Option, Predicate, Ref, Schema } from "effect"
import { Context, Layer } from "effect"
import type { Scope } from "effect"
import type { Prompt } from "effect/ai"
import { expect, refuses, show, unexpected } from "../conformance.entity.functions.js"
import {
  assistantMessage, ConformanceFailure, Core, EventName, kernel, Seq, SessionId, stored, storedEvent, turnEnded, TurnNumber, turnStarted, userMessage,
} from "@xandreed/core/kernel"
import type { ConformanceCheck, OpenSession, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import type { Memory } from "./memory.port.js"
import { estimateContext } from "./memory.entity.functions.js"

type CoreShape = Context.Service.Shape<typeof Core>
type MemoryShape = Context.Service.Shape<typeof Memory>

/**
 * A memory plugin as the kit opens it: a fresh one per check, on the
 * `Core` the kit hands it, released with its scope. The kit is told the
 * plugin's name (its records are under `plugin.<name>.`) and, for a memory
 * that keeps to a budget, the budget, so it can count what the plugin counts.
 *
 * @public
 */
export interface MemorySubject {
  readonly name: string
  readonly budgetTokens?: number
  readonly open: (core: CoreShape) => Effect.Effect<MemoryShape, never, Scope.Scope>
}

const sessionId = SessionId.make("kit-session")

/** A journal the kit writes, and the open session over it that a memory is given. */
const kitSession = Effect.gen(function* () {
  const journal = yield* Ref.make<ReadonlyArray<StoredEvent>>([])
  const turns = yield* Ref.make(0)
  const append = (event: StoredDraft) => Effect.flatMap(Ref.get(turns), (turn) => Ref.modify(journal, (events) => {
    const kept: StoredEvent = { seq: Seq.make(events.length + 1), at: 1_767_225_600_000, turn: TurnNumber.make(Math.max(1, turn)), ...event }
    return [kept, [...events, kept]] as const
  }))
  /** A whole earlier turn: its message and the answer. */
  const pastTurn = (asked: string, answered: string) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    yield* append(userMessage(asked))
    yield* append(assistantMessage(answered))
    yield* append(turnEnded(turn, { _tag: "Completed" }))
  })
  /** The turn that is open: its start and its message, and the session a memory opens. */
  const openTurn = (asked: string) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    yield* append(userMessage(asked))
    const session: OpenSession = { id: sessionId, turn, journal: Ref.get(journal), append }
    return session
  })
  /** Close the open turn with the model's answer. */
  const closeTurn = (session: OpenSession, answered: string) => Effect.gen(function* () {
    yield* append(assistantMessage(answered))
    yield* append(turnEnded(session.turn, { _tag: "Completed" }))
  })
  return { journal: Ref.get(journal), append, pastTurn, openTurn, closeTurn }
})

/** The text of a prompt message, as the kit compares it. */
const textOf = (message: Prompt.MessageEncoded): string => typeof message.content === "string" ? message.content : show(message.content)

/**
 * The memory contract as checks, each over a journal the kit writes: the
 * context ends with the message the turn answers (`turn-message`); every
 * message in it is the user's or the model's, with the text of a record of
 * the conversation (`conversation`); a record of another use that bears
 * text is never in it (`other-uses`); what memory appends while it builds
 * is under its own prefix and tagged `memory` (`own-records`); while
 * nothing presses, the next turn's context starts with this turn's, so the
 * prefix a provider cached stays (`prefix`); for a memory with a budget,
 * over a journal longer than the budget the context still fits and still
 * answers the turn (`fits`), and a turn that alone is over the budget fails
 * with an error carrying `estimatedTokens` and `budgetTokens` (`over-budget`);
 * an unknown record under its own prefix is passed over when it may be
 * skipped (`unknown-skipped`) and refused with `UnknownRecord` when it may
 * not (`unknown-refused`); so is an unknown record of the conversation
 * that may not be skipped, since a memory reads the conversation with its
 * reader (`readerFor(name, own, CONVERSATION_READER)`), not its own prefix
 * alone (`unknown-conversation-refused`); another plugin's record it does not
 * know is not its concern (`foreign`).
 *
 * @public
 */
export const memoryConformance = (subject: MemorySubject): ReadonlyArray<ConformanceCheck> => {
  type Kit = Effect.Success<typeof kitSession>
  const check = (
    name: string,
    id: string,
    body: (memory: MemoryShape, kit: Kit) => Effect.Effect<void, { readonly _tag: string; readonly message: string }, Scope.Scope>,
  ): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const memory = yield* subject.open(Context.get(yield* Layer.build(kernel()), Core))
      yield* body(memory, yield* kitSession)
    })).pipe(unexpected(id)),
  })
  const answersTurn = (id: string, context: ReadonlyArray<Prompt.MessageEncoded>, asked: string) => {
    const last = context.at(-1)
    return expect(id, last !== undefined && last.role === "user" && textOf(last) === asked, `the context ${show(context)} does not end with the message the turn answers`)
  }
  const own = `plugin.${subject.name}.`
  const unknown = (skippable: boolean, plugin: string = subject.name) => stored(storedEvent(plugin, "kit-unknown", { data: Schema.Struct({}), skippable, tags: ["memory"] }), {})
  const unknownConversation = (skippable: boolean): StoredDraft =>
    ({ name: EventName.make("conversation.kit.unknown"), data: {}, skippable, tags: userMessage("").tags, message: { _tag: "User", text: "an unknown record of the conversation" } })
  const budget = Option.fromNullishOr(subject.budgetTokens)
  const long = "long ".repeat(Math.max(1, Math.ceil(Option.getOrElse(budget, () => 400) / 4)))
  /** The checks of a budget, for a memory that keeps to one. */
  const budgeted = (checks: (budgetTokens: number) => ReadonlyArray<ConformanceCheck>) => Option.match(budget, { onNone: () => [], onSome: checks })

  return [
    check("the context ends with the message the turn answers", "turn-message", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const session = yield* kit.openTurn("And a scope?")
      yield* answersTurn("turn-message", yield* memory.context(session), "And a scope?")
    })),
    check("every message of the context is the user's or the model's, from a record of the conversation", "conversation", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const session = yield* kit.openTurn("And a scope?")
      const context = yield* memory.context(session)
      const said = new Set((yield* kit.journal).flatMap((event) => event.message === undefined ? [] : [`${event.message._tag === "User" ? "user" : "assistant"} ${event.message.text}`]))
      yield* expect("conversation", context.length > 0 && context.every((message) => said.has(`${message.role} ${textOf(message)}`)),
        `the context ${show(context)} holds a message no record of the conversation bears`)
    })),
    check("a record of another use that bears text is never in the context", "other-uses", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(stored(storedEvent("kit-client", "drawn", { data: Schema.Struct({}), skippable: true, tags: ["ui"] }), {}, { message: { _tag: "User", text: "a label a client draws" } }))
      const session = yield* kit.openTurn("And a scope?")
      const context = yield* memory.context(session)
      yield* expect("other-uses", context.every((message) => textOf(message) !== "a label a client draws"), `a record tagged ui reached the context: ${show(context)}`)
    })),
    check("what memory appends while it builds is under its own prefix, tagged memory", "own-records", (memory, kit) => Effect.gen(function* () {
      yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => kit.pastTurn(long, long), { concurrency: 1, discard: true })
      const session = yield* kit.openTurn("And a scope?")
      const before = (yield* kit.journal).length
      yield* memory.context(session)
      const written = (yield* kit.journal).slice(before)
      yield* expect("own-records", written.every((event) => event.name.startsWith(own) && event.tags.some((tag) => tag === "memory")),
        `while it built, memory appended ${show(written.map((event) => `${event.name} ${event.tags.join(",")}`))}, not all under ${own} and tagged memory`)
    })),
    check("while nothing presses, the next context starts with this one", "prefix", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const first = yield* kit.openTurn("And a scope?")
      const earlier = yield* memory.context(first)
      yield* kit.closeTurn(first, "What a resource lives in.")
      const second = yield* kit.openTurn("And a layer?")
      const later = yield* memory.context(second)
      yield* expect("prefix", show(later.slice(0, earlier.length)) === show(earlier), `the next turn's context ${show(later)} does not start with ${show(earlier)}`)
    })),
    ...budgeted((budgetTokens) => [
      check("over a journal longer than the budget, the context still fits and answers the turn", "fits", (memory, kit) => Effect.gen(function* () {
        yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => kit.pastTurn(long, long), { concurrency: 1, discard: true })
        const session = yield* kit.openTurn("And a scope?")
        const context = yield* memory.context(session)
        yield* expect("fits", estimateContext(context) <= budgetTokens, `the context is estimated at ${estimateContext(context)}, over its budget of ${budgetTokens}`)
        yield* answersTurn("fits", context, "And a scope?")
      })),
      check("a turn that alone is over the budget fails, with the estimate and the budget", "over-budget", (memory, kit) => Effect.gen(function* () {
        const session = yield* kit.openTurn(long.repeat(8))
        yield* refuses("over-budget", "a context whose turn alone is over the budget", memory.context(session), (error) =>
          Predicate.hasProperty(error, "estimatedTokens") && Predicate.isNumber(error.estimatedTokens)
          && Predicate.hasProperty(error, "budgetTokens") && error.budgetTokens === budgetTokens && error.estimatedTokens > budgetTokens)
      })),
    ]),
    check("an unknown record of its own that may be skipped is passed over", "unknown-skipped", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(unknown(true))
      const session = yield* kit.openTurn("And a scope?")
      yield* Effect.mapError(memory.context(session), (error) => new ConformanceFailure({ check: "unknown-skipped", message: `a context over a record that may be skipped failed with ${error._tag}: ${error.message}` }))
    })),
    check("an unknown record of its own that may not be skipped is refused", "unknown-refused", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(unknown(false))
      const session = yield* kit.openTurn("And a scope?")
      yield* refuses("unknown-refused", "a context over a record that may not be skipped", memory.context(session), (error) => error._tag === "UnknownRecord")
    })),
    check("an unknown record of the conversation that may not be skipped is refused", "unknown-conversation-refused", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(unknownConversation(false))
      const session = yield* kit.openTurn("And a scope?")
      yield* refuses("unknown-conversation-refused", "a context over a record of the conversation that may not be skipped", memory.context(session), (error) => error._tag === "UnknownRecord")
    })),
    check("another plugin's record it does not know is not its concern", "foreign", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(stored(storedEvent("kit-stranger", "noted", { data: Schema.Struct({}), skippable: false, tags: ["trace"] }), {}))
      const session = yield* kit.openTurn("And a scope?")
      yield* Effect.mapError(memory.context(session), (error) => new ConformanceFailure({ check: "foreign", message: `a context over another plugin's record failed with ${error._tag}: ${error.message}` }))
    })),
  ]
}
