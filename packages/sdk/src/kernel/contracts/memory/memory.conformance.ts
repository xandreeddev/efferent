import { Effect, Option, Predicate, Ref, Schema } from "effect"
import { Context, Layer } from "effect"
import type { Scope } from "effect"
import type { Prompt } from "effect/ai"
import { expect, refuses, show, unexpected } from "../conformance.entity.functions.js"
import {
  assistantMessage, ConformanceFailure, CONVERSATION_VOCABULARY, Core, EventName, isStoredDraft, kernel, live, messageOf, readJournal, Seq, SessionId, SessionRefused, stored, storedEvent, toolResult, turnEnded, TurnNumber,
  turnStarted, userMessage,
} from "@xandreed/core/kernel"
import type { ConformanceCheck, OpenSession, StoredDraft, StoredEvent } from "@xandreed/core/kernel"
import { Memory } from "./memory.port.js"
import { estimateContext, messageText, paired, promptMessage } from "./memory.entity.functions.js"
import { pointed } from "./pointer.entity.functions.js"
import type { PointerOptions } from "./pointer.entity.js"

type CoreShape = Context.Service.Shape<typeof Core>
type MemoryShape = Context.Service.Shape<typeof Memory>

/**
 * A memory plugin as the kit opens it: a fresh one per check, on the
 * `Core` the kit hands it, released with its scope. The kit is told the
 * plugin's name (its records are under `plugin.<name>.`) and, for a memory
 * that keeps to a budget, the budget, so it can count what the plugin counts;
 * for one that sends long results as pointers, its pointer options, so the
 * kit can say what each result must be sent as.
 *
 * @public
 */
export interface MemorySubject {
  readonly name: string
  readonly budgetTokens?: number
  readonly pointers?: PointerOptions
  readonly open: (core: CoreShape) => Effect.Effect<MemoryShape, never, Scope.Scope>
}

const sessionId = SessionId.make("kit-session")

/** A record as the kit puts it in its journal: a draft's fields, or those of a record no definition of this kernel makes. */
type KitRecord = Omit<StoredEvent, "seq" | "at" | "turn">

/**
 * A journal the kit writes, and the open session over it that a memory is given. What the memory publishes through
 * that session goes to `core`, the one the kit handed the plugin.
 */
const kitSession = (core: CoreShape) => Effect.gen(function* () {
  const journal = yield* Ref.make<ReadonlyArray<StoredEvent>>([])
  const turns = yield* Ref.make(0)
  /** Put a record at the next place of the kit's journal, as it is: the kit writes records no draft could be. */
  const appendRecord = (event: KitRecord) => Effect.flatMap(Ref.get(turns), (turn) => Ref.modify(journal, (events) => {
    const kept: StoredEvent = { seq: Seq.make(events.length + 1), at: 1_767_225_600_000, turn: TurnNumber.make(Math.max(1, turn)), ...event }
    return [kept, [...events, kept]] as const
  }))
  /** What a memory appends, as a session takes it: only what `stored` made. */
  const append = (event: StoredDraft) => isStoredDraft(event)
    ? appendRecord(event)
    : Effect.fail(new SessionRefused({ reason: "NotADraft", message: "this value is not a record `stored(definition, data)` made from a definition `storedEvent` made" }))
  /** A whole earlier turn: its message and the answer. */
  const pastTurn = (asked: string, answered: string) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    yield* append(userMessage(asked))
    yield* append(assistantMessage(answered))
    yield* append(turnEnded(turn, { _tag: "Completed" }))
  })
  /**
   * A whole earlier turn that called a tool: its message, the model's call (`id`), and then, when `answered`, the
   * tool's result and the model's answer, closed `Completed`; otherwise closed `Interrupted` with the call unanswered,
   * as a turn stopped while its tool ran.
   */
  const toolTurn = (asked: string, id: string, answered: boolean) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    yield* append(userMessage(asked))
    yield* append(assistantMessage("", { toolCalls: [{ id, name: "add", params: { a: 2, b: 3 } }] }))
    if (answered) {
      yield* append(toolResult({ id, name: "add" }, 5))
      yield* append(assistantMessage("It is 5."))
    }
    yield* append(turnEnded(turn, answered ? { _tag: "Completed" } : { _tag: "Interrupted" }))
  })
  /** A whole earlier turn whose tool answered with `result`: the stored result is given back. */
  const resultTurn = (asked: string, id: string, result: string, whole = false) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    yield* append(userMessage(asked))
    yield* append(assistantMessage("", { toolCalls: [{ id, name: "lookup", params: {} }] }))
    const kept = yield* append(toolResult({ id, name: "lookup" }, result, false, { whole }))
    yield* append(assistantMessage("Done."))
    yield* append(turnEnded(turn, { _tag: "Completed" }))
    return kept
  })
  /** The turn that is open: its start and its message, and the session a memory opens. */
  const openTurn = (asked: string) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    yield* append(userMessage(asked))
    const session: OpenSession = {
      id: sessionId,
      turn,
      journal: Ref.get(journal),
      append,
      publish: (definition, data) => core.publish(live(definition, { id: sessionId, turn }, data)),
    }
    return session
  })
  /** Close the open turn with the model's answer. */
  const closeTurn = (session: OpenSession, answered: string) => Effect.gen(function* () {
    yield* append(assistantMessage(answered))
    yield* append(turnEnded(session.turn, { _tag: "Completed" }))
  })
  return { journal: Ref.get(journal), append, appendRecord, pastTurn, toolTurn, resultTurn, openTurn, closeTurn }
})

/** The ids of the tool calls a context sends, and of the results it sends, in order. */
const toolTraffic = (context: ReadonlyArray<Prompt.MessageEncoded>) => {
  const parts = context.flatMap((message) => (typeof message.content === "string" ? [] : message.content.map((part) => ({ role: message.role, part }))))
  return {
    calls: parts.flatMap(({ role, part }) => (role === "assistant" && part.type === "tool-call" ? [part.id] : [])),
    results: parts.flatMap(({ role, part }) => (role === "tool" && part.type === "tool-result" ? [part.id] : [])),
  }
}

/** What a context sends as the result of the call `id`: each one it sends, as the kit compares it. */
const resultsOf = (context: ReadonlyArray<Prompt.MessageEncoded>, id: string): ReadonlyArray<string> =>
  context.flatMap((message) => (typeof message.content === "string" ? [] : message.content.flatMap((part) => (message.role === "tool" && part.type === "tool-result" && part.id === id ? [show(part.result)] : []))))

/** What a stored result must be sent as under pointer options: `pointed`'s word for its record. */
const pointedResult = (options: PointerOptions, record: StoredEvent): string =>
  show(Option.match(pointed(options)(record), { onNone: () => null, onSome: (message) => (message._tag === "ToolResult" ? message.result : null) }))

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
 * vocabulary (`vocabularyOf(name, own, CONVERSATION_VOCABULARY)`), not its own prefix
 * alone (`unknown-conversation-refused`); another plugin's record it does not
 * know is not its concern (`foreign`); a tool call is sent with its result
 * and right before it, and a call no result answers (a turn stopped while its
 * tool ran) is not sent, also when its id is asked again later and answered
 * (`pairs`). For a memory that sends long results as pointers (a subject
 * with `pointers`): a long result is sent as `pointed` gives it and a short
 * one as stored (`pointer`); one its tool marked `whole` is sent as stored,
 * however long (`pointer-whole`); a long result
 * is sent the same way in the turn that fetched it and in the next
 * (`pointer-stable`); and, with a budget, a turn whose result alone is over
 * the budget fits once pointed, since the budget counts what is sent
 * (`pointer-budget`).
 *
 * @public
 */
export const memoryConformance = (subject: MemorySubject): ReadonlyArray<ConformanceCheck> => {
  type Kit = Effect.Success<ReturnType<typeof kitSession>>
  const check = (
    name: string,
    id: string,
    body: (memory: MemoryShape, kit: Kit) => Effect.Effect<void, { readonly _tag: string; readonly message: string }, Scope.Scope>,
  ): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const core = Context.get(yield* Layer.build(kernel()), Core)
      const memory = yield* subject.open(core)
      yield* body(memory, yield* kitSession(core))
    })).pipe(unexpected(id)),
  })
  const answersTurn = (id: string, context: ReadonlyArray<Prompt.MessageEncoded>, asked: string) => {
    const last = context.at(-1)
    return expect(id, last !== undefined && last.role === "user" && textOf(last) === asked, `the context ${show(context)} does not end with the message the turn answers`)
  }
  const own = `plugin.${subject.name}.`
  const unknown = (skippable: boolean, plugin: string = subject.name) => stored(storedEvent(plugin, "kit-unknown", { data: Schema.Struct({}), skippable, tags: ["memory"] }), {})
  /** A record of the conversation no definition of this kernel makes: one a later core may write. */
  const unknownConversation = (skippable: boolean): KitRecord =>
    ({ name: EventName.make("conversation.kit.unknown"), data: {}, skippable, tags: userMessage("").tags, message: { _tag: "User", text: "an unknown record of the conversation" } })
  const budget = Option.fromNullishOr(subject.budgetTokens)
  const long = "long ".repeat(Math.max(1, Math.ceil(Option.getOrElse(budget, () => 400) / 4)))
  const pointers = Option.fromNullishOr(subject.pointers)
  /** The checks of pointers, for a memory that sends long results as pointers. */
  const pointing = (checks: (options: PointerOptions) => ReadonlyArray<ConformanceCheck>) => Option.match(pointers, { onNone: () => [], onSome: checks })
  /** A result of about `tokens` tokens, by memory's estimate. */
  const resultOf = (tokens: number) => "result ".repeat(Math.ceil(tokens * 4 / 7))
  /** A result twice the size a pointer stands for: small enough that a budgeted memory still keeps its turn. */
  const longResult = (options: PointerOptions) => resultOf(options.overTokens * 2)
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
      const said = new Set((yield* kit.journal).flatMap((event) => event.message === undefined ? [] : [`${event.message._tag === "User" ? "user" : "assistant"} ${messageText(event.message)}`]))
      yield* expect("conversation", context.length > 0 && context.every((message) => said.has(`${message.role} ${textOf(message)}`)),
        `the context ${show(context)} holds a message no record of the conversation bears`)
    })),
    check("a tool call is sent with its result, right before it, and a call no result answers is not sent, its id asked again or not", "pairs", (memory, kit) => Effect.gen(function* () {
      yield* kit.toolTurn("What is 2 + 3?", "kit-call-1", true)
      yield* kit.toolTurn("And again?", "kit-call-2", false)
      // A call's id is the model's, and can repeat: the id of the call left open is asked again, and answered.
      yield* kit.toolTurn("Once more?", "kit-call-2", true)
      const session = yield* kit.openTurn("Thanks.")
      const context = yield* memory.context(session)
      const { calls, results } = toolTraffic(context)
      /** Whether the call of `id` is sent once, with its result as the next message. */
      const answeredOnce = (id: string) => context.filter((message, index) =>
        message.role === "assistant" && toolTraffic([message]).calls.includes(id) && show(toolTraffic(context.slice(index + 1, index + 2)).results) === show([id])).length === 1
      yield* expect("pairs", show(calls.slice(0, 1)) === show(["kit-call-1"]) && show(results.slice(0, 1)) === show(["kit-call-1"]) && answeredOnce("kit-call-1"),
        `the context ${show(context)} does not send the answered call with its result right after it`)
      yield* expect("pairs", show(calls) === show(["kit-call-1", "kit-call-2"]) && show(results) === show(["kit-call-1", "kit-call-2"]) && answeredOnce("kit-call-2"),
        `the context ${show(context)} does not send each answered call once with its result right after it, and the unanswered call not at all: a result answers the last call of its id before it, not every call of that id`)
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
    ...pointing((options) => [
      check("a long result is sent as its pointer, with its call, and a short one as stored", "pointer", (memory, kit) => Effect.gen(function* () {
        const long = yield* kit.resultTurn("Look it up.", "kit-call-1", longResult(options))
        yield* kit.resultTurn("A short one.", "kit-call-2", "short")
        const session = yield* kit.openTurn("Thanks.")
        const context = yield* memory.context(session)
        yield* expect("pointer", show(resultsOf(context, "kit-call-1")) === show([pointedResult(options, long)]) && show(toolTraffic(context).calls) === show(["kit-call-1", "kit-call-2"]),
          `a result over ${options.overTokens} tokens was sent as ${show(resultsOf(context, "kit-call-1")).slice(0, 300)}, not once as its pointer ${pointedResult(options, long)} with its call`)
        yield* expect("pointer", show(resultsOf(context, "kit-call-2")) === show([show("short")]), `a short result was sent as ${show(resultsOf(context, "kit-call-2"))}, not as stored`)
      })),
      check("a long result its tool marked whole is sent as stored", "pointer-whole", (memory, kit) => Effect.gen(function* () {
        const manual = resultOf(options.overTokens * 1.25)
        yield* kit.resultTurn("The manual.", "kit-call-1", manual, true)
        const session = yield* kit.openTurn("Thanks.")
        const context = yield* memory.context(session)
        yield* expect("pointer-whole", show(resultsOf(context, "kit-call-1")) === show([show(manual)]),
          `a result its tool marked whole was sent as ${show(resultsOf(context, "kit-call-1")).slice(0, 300)}, not as stored`)
      })),
      check("a long result is sent the same way in the turn that fetched it and in the next", "pointer-stable", (memory, kit) => Effect.gen(function* () {
        const first = yield* kit.openTurn("Look it up.")
        yield* kit.append(assistantMessage("", { toolCalls: [{ id: "kit-call-1", name: "lookup", params: {} }] }))
        const long = yield* kit.append(toolResult({ id: "kit-call-1", name: "lookup" }, longResult(options)))
        const now = resultsOf(yield* memory.context(first), "kit-call-1")
        yield* kit.closeTurn(first, "Done.")
        const later = resultsOf(yield* memory.context(yield* kit.openTurn("Thanks.")), "kit-call-1")
        yield* expect("pointer-stable", show(now) === show([pointedResult(options, long)]) && show(later) === show(now),
          `a long result was sent as ${show(now).slice(0, 200)} in its own turn and as ${show(later).slice(0, 200)} in the next, not both times as its pointer`)
      })),
      ...budgeted((budgetTokens) => [
        check("a turn whose result alone is over the budget fits once pointed: the budget counts what is sent", "pointer-budget", (memory, kit) => Effect.gen(function* () {
          const session = yield* kit.openTurn("Look it up.")
          yield* kit.append(assistantMessage("", { toolCalls: [{ id: "kit-call-1", name: "lookup", params: {} }] }))
          yield* kit.append(toolResult({ id: "kit-call-1", name: "lookup" }, resultOf(Math.max(options.overTokens, budgetTokens) * 2)))
          const context = yield* Effect.mapError(memory.context(session), (error) => new ConformanceFailure({ check: "pointer-budget", message: `a turn whose result fits the budget as a pointer failed with ${error._tag}: ${error.message}` }))
          yield* expect("pointer-budget", estimateContext(context) <= budgetTokens, `the context is estimated at ${estimateContext(context)}, over its budget of ${budgetTokens}`)
        })),
      ]),
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
      yield* kit.appendRecord(unknownConversation(false))
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

/**
 * A wrapper of `Memory` as the kit opens it: a higher-order plugin, given the
 * memory it wraps and returning the wrapped one, built on the `Core` the kit
 * hands it. `name` is the wrapper's: what it appends while it builds is
 * under `plugin.<name>.`.
 *
 * @public
 */
export interface MemoryWrapperSubject {
  readonly name: string
  readonly wrap: (inner: Layer.Layer<Memory>) => Layer.Layer<Memory, never, Core>
}

/**
 * The memory the kit gives a wrapper to wrap: every message of the
 * conversation, as the flat memory sends it. The kit compares the wrapped
 * context with it.
 */
const innerMemory: Layer.Layer<Memory> = Layer.succeed(Memory, Memory.of({
  context: Effect.fnUntraced(function* (session: OpenSession) {
    const conversation = yield* Effect.fromResult(readJournal(CONVERSATION_VOCABULARY)(yield* session.journal))
    return paired(conversation.flatMap((record) => Option.toArray(messageOf(record)))).map(promptMessage)
  }),
}))

/**
 * A wrapper of memory as checks (ADR 0005), each over a journal the kit
 * writes and the inner memory above: the wrapped context starts with the
 * inner memory's context, whole and in its order, so what a wrapper adds for
 * the request comes after it and the cached prefix the inner memory keeps
 * still holds (`starts-with-inner`); what the wrapper appends while it
 * builds is under its own prefix and never a record of the conversation, so
 * what it adds for one request is not stored as something said
 * (`own-records`).
 *
 * @public
 */
export const memoryWrapperConformance = (subject: MemoryWrapperSubject): ReadonlyArray<ConformanceCheck> => {
  type Kit = Effect.Success<ReturnType<typeof kitSession>>
  const check = (
    name: string,
    id: string,
    body: (wrapped: MemoryShape, inner: MemoryShape, kit: Kit) => Effect.Effect<void, { readonly _tag: string; readonly message: string }, Scope.Scope>,
  ): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const built = yield* Layer.build(kernel())
      const wrapped = Context.get(yield* Layer.build(subject.wrap(innerMemory).pipe(Layer.provide(Layer.succeedContext(built)))), Memory)
      const inner = Context.get(yield* Layer.build(innerMemory), Memory)
      yield* body(wrapped, inner, yield* kitSession(Context.get(built, Core)))
    })).pipe(unexpected(id)),
  })
  const own = `plugin.${subject.name}.`
  return [
    check("the wrapped context starts with the inner memory's, whole and in order", "starts-with-inner", (wrapped, inner, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.toolTurn("What is 2 + 3?", "kit-call-1", true)
      const session = yield* kit.openTurn("And a scope?")
      const below = yield* inner.context(session)
      const context = yield* wrapped.context(session)
      yield* expect("starts-with-inner", show(context.slice(0, below.length)) === show(below),
        `the wrapped context ${show(context)} does not start with the inner memory's ${show(below)}`)
    })),
    check("what the wrapper appends while it builds is under its own prefix, never the conversation's", "own-records", (wrapped, _inner, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const session = yield* kit.openTurn("And a scope?")
      const before = (yield* kit.journal).length
      yield* wrapped.context(session)
      const written = (yield* kit.journal).slice(before)
      yield* expect("own-records", written.every((event) => event.name.startsWith(own) && !event.tags.some((tag) => tag === "conversation")),
        `while it built, the wrapper appended ${show(written.map((event) => `${event.name} ${event.tags.join(",")}`))}, not all under ${own} and none of the conversation`)
    })),
  ]
}
