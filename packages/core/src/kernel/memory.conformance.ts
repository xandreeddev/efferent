import { Effect, Option, Predicate, Ref, Result, Schema } from "effect"
import type { Context, Scope } from "effect"
import { expect, fail, refuses, show, unexpected } from "./conformance.entity.functions.js"
import type { ConformanceCheck } from "./conformance.entity.js"
import { makeCore } from "./core.adapter.js"
import type { Core } from "./core.port.js"
import { stored, storedEvent } from "./event.entity.functions.js"
import type { StoredDraft, StoredEvent } from "./event.entity.js"
import { firstStep } from "./ids.entity.functions.js"
import { Seq, SessionId, TurnNumber } from "./ids.entity.js"
import type { Memory } from "./memory.port.js"
import { estimateRequest, estimateTokens, resolveRequest, turnMessageOf } from "./request.entity.functions.js"
import type { ModelRequest } from "./request.entity.js"
import type { OpenSession } from "./sessions.port.js"
import { assistantMessage, requestSent, turnEnded, turnStarted, userMessage } from "./vocabulary.entity.functions.js"

type CoreShape = Context.Service.Shape<typeof Core>
type MemoryShape = Context.Service.Shape<typeof Memory>

/**
 * A memory plugin as the kit opens it: a fresh one per check, on the
 * `Core` the kit hands it, released with its scope. The kit is told the
 * plugin's name (its records are under `plugin.<name>.`), the system text
 * its settings hold and its budget, so it can count what the plugin counts.
 *
 * @public
 */
export interface MemorySubject {
  readonly name: string
  readonly system: string
  readonly budgetTokens: number
  readonly open: (core: CoreShape) => Effect.Effect<MemoryShape, never, Scope.Scope>
}

const sessionId = SessionId.make("kit-session")

/** A journal the kit writes, and the open session over it that a memory is given. */
const kitSession = Effect.gen(function* () {
  const journal = yield* Ref.make<ReadonlyArray<StoredEvent>>([])
  const turns = yield* Ref.make(0)
  const append = (event: StoredDraft) => Ref.modify(journal, (events) => {
    const kept: StoredEvent = { seq: Seq.make(events.length + 1), at: 1_767_225_600_000, ...event }
    return [kept, [...events, kept]] as const
  })
  /** A whole earlier turn: its message, the request that sent it and the answer. */
  const pastTurn = (asked: string, answered: string) => Effect.gen(function* () {
    const turn = TurnNumber.make(yield* Ref.updateAndGet(turns, (count) => count + 1))
    yield* append(turnStarted(turn))
    const message = yield* append(userMessage(asked))
    yield* append(requestSent(firstStep, "", { messages: [message.seq], estimatedTokens: estimateTokens(asked), budgetTokens: estimateTokens(asked) }))
    yield* append(assistantMessage(firstStep, { _tag: "Assistant", text: answered, toolCalls: [] }))
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
    yield* append(assistantMessage(firstStep, { _tag: "Assistant", text: answered, toolCalls: [] }))
    yield* append(turnEnded(session.turn, { _tag: "Completed" }))
  })
  return { journal: Ref.get(journal), append, pastTurn, openTurn, closeTurn }
})

/**
 * The memory contract as checks, each over a journal the kit writes: the
 * request points at the message the turn answers (`turn-message`); every
 * pointer is the place of a record that bears a message, none twice
 * (`pointers`); the estimate is core's estimate of the system text and the
 * messages pointed at, within the budget (`estimate`); what memory appends
 * while it builds is under its own prefix (`own-records`); while nothing
 * presses, the next turn's request starts with this turn's, so the prefix a
 * provider cached stays (`prefix`); over a journal longer than the budget
 * the request still fits and still answers the turn (`fits`); a turn that
 * alone is over the budget fails with an error carrying `estimatedTokens`
 * and `budgetTokens`, never a request over its budget (`over-budget`); an
 * unknown record under its own prefix is passed over when it may be
 * skipped (`unknown-skipped`) and refused with `UnknownRecord` when it may
 * not (`unknown-refused`); another plugin's record it does not know is not
 * its concern (`foreign`).
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
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const memory = yield* subject.open(yield* makeCore())
      yield* body(memory, yield* kitSession)
    })).pipe(unexpected(id)),
  })
  /** The first request of the session's open turn. */
  const build = (memory: MemoryShape, session: OpenSession) => Effect.flatMap(memory.open(session), (opened) => opened.build(firstStep))
  /** The request, resolved against the journal as it is after the build. */
  const resolved = (id: string, kit: Kit, request: ModelRequest) => Effect.flatMap(kit.journal, (journal) =>
    Result.match(resolveRequest(journal, { system: subject.system, ...request }), {
      onFailure: (refusal) => fail(id, `the request does not resolve: ${refusal.message}`),
      onSuccess: (sent) => Effect.succeed(sent),
    }))
  const answersTurn = (id: string, kit: Kit, request: ModelRequest) => Effect.flatMap(kit.journal, (journal) =>
    expect(id, Option.exists(turnMessageOf(journal), (seq) => request.messages.includes(seq)), `the request ${show(request.messages)} leaves out the message the turn answers`))
  const own = `plugin.${subject.name}.`
  const unknown = (skippable: boolean) => stored(storedEvent(subject.name, "kit-unknown", { data: Schema.Struct({}), skippable }), {})
  const long = "long ".repeat(Math.max(1, Math.ceil(subject.budgetTokens / 4)))

  return [
    check("the request points at the message the turn answers", "turn-message", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const session = yield* kit.openTurn("And a scope?")
      yield* answersTurn("turn-message", kit, yield* build(memory, session))
    })),
    check("every pointer is the place of a record that bears a message", "pointers", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const session = yield* kit.openTurn("And a scope?")
      const request = yield* build(memory, session)
      const sent = yield* resolved("pointers", kit, request)
      yield* expect("pointers", sent.messages.length === request.messages.length && sent.messages.length > 0, `the request ${show(request.messages)} resolved to ${sent.messages.length} messages`)
    })),
    check("the estimate is core's estimate of what is sent, within the budget", "estimate", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const session = yield* kit.openTurn("And a scope?")
      const request = yield* build(memory, session)
      const sent = yield* resolved("estimate", kit, request)
      const counted = estimateRequest(subject.system, sent.messages.map((pointed) => pointed.message))
      yield* expect("estimate", request.estimatedTokens === counted, `the request is estimated at ${request.estimatedTokens}; core counts ${counted}`)
      yield* expect("estimate", request.estimatedTokens <= request.budgetTokens && request.budgetTokens === subject.budgetTokens,
        `the request is estimated at ${request.estimatedTokens} under a budget of ${request.budgetTokens}; the subject's is ${subject.budgetTokens}`)
    })),
    check("what memory appends while it builds is under its own prefix", "own-records", (memory, kit) => Effect.gen(function* () {
      yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => kit.pastTurn(long, long), { concurrency: 1, discard: true })
      const session = yield* kit.openTurn("And a scope?")
      const before = (yield* kit.journal).length
      yield* build(memory, session)
      const written = (yield* kit.journal).slice(before)
      yield* expect("own-records", written.every((event) => event.name.startsWith(own)), `while it built, memory appended ${show(written.map((event) => event.name))}, not all under ${own}`)
    })),
    check("while nothing presses, the next request starts with this one", "prefix", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      const first = yield* kit.openTurn("And a scope?")
      const earlier = yield* build(memory, first)
      yield* kit.closeTurn(first, "What a resource lives in.")
      const second = yield* kit.openTurn("And a layer?")
      const later = yield* build(memory, second)
      yield* expect("prefix", show(later.messages.slice(0, earlier.messages.length)) === show(earlier.messages),
        `the next turn's request ${show(later.messages)} does not start with ${show(earlier.messages)}`)
    })),
    check("over a journal longer than the budget, the request still fits and answers the turn", "fits", (memory, kit) => Effect.gen(function* () {
      yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8], () => kit.pastTurn(long, long), { concurrency: 1, discard: true })
      const session = yield* kit.openTurn("And a scope?")
      const request = yield* build(memory, session)
      yield* expect("fits", request.estimatedTokens <= request.budgetTokens, `the request is estimated at ${request.estimatedTokens}, over its budget of ${request.budgetTokens}`)
      yield* answersTurn("fits", kit, request)
      yield* resolved("fits", kit, request)
    })),
    check("a turn that alone is over the budget fails, with the estimate and the budget", "over-budget", (memory, kit) => Effect.gen(function* () {
      const session = yield* kit.openTurn(long.repeat(8))
      yield* refuses("over-budget", "a build whose turn alone is over the budget", build(memory, session), (error) =>
        Predicate.hasProperty(error, "estimatedTokens") && Predicate.isNumber(error.estimatedTokens)
        && Predicate.hasProperty(error, "budgetTokens") && error.budgetTokens === subject.budgetTokens && error.estimatedTokens > subject.budgetTokens)
    })),
    check("an unknown record of its own that may be skipped is passed over", "unknown-skipped", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(unknown(true))
      const session = yield* kit.openTurn("And a scope?")
      yield* answersTurn("unknown-skipped", kit, yield* build(memory, session))
    })),
    check("an unknown record of its own that may not be skipped is refused", "unknown-refused", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(unknown(false))
      const session = yield* kit.openTurn("And a scope?")
      yield* refuses("unknown-refused", "a build over a record that may not be skipped", build(memory, session), (error) => error._tag === "UnknownRecord")
    })),
    check("another plugin's record it does not know is not its concern", "foreign", (memory, kit) => Effect.gen(function* () {
      yield* kit.pastTurn("What is a fiber?", "A light thread.")
      yield* kit.append(stored(storedEvent("kit-stranger", "noted", { data: Schema.Struct({}), skippable: false }), {}))
      const session = yield* kit.openTurn("And a scope?")
      yield* answersTurn("foreign", kit, yield* build(memory, session))
    })),
  ]
}
