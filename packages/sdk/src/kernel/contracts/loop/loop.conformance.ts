import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Schema, Scope } from "effect"
import { expect, refuses, show, unexpected } from "../conformance.entity.functions.js"
import { Core, dataOf, kernel, Owner, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { ConformanceCheck, KernelEvent, Sessions } from "@xandreed/core/kernel"
import type { LoopScript } from "./loop.entity.js"
import type { Loop } from "./loop.port.js"
import { resolveRequest, turnMessageOf } from "./request.entity.functions.js"
import { assistantDeltaEvent, assistantMessageEvent, requestSentEvent, userMessageEvent } from "./conversation.entity.js"

type CoreShape = Context.Service.Shape<typeof Core>

/**
 * A loop plugin as the kit opens it: a fresh one per check, with the
 * session, memory and storage plugins it runs over, on the `Core` the kit
 * hands it, its model following `script`. The kit reads what the loop
 * stored through the same session plugin.
 *
 * @public
 */
export interface LoopSubject {
  readonly open: (core: CoreShape, script: LoopScript) => Effect.Effect<{
    readonly loop: Context.Service.Shape<typeof Loop>
    readonly sessions: Context.Service.Shape<typeof Sessions>
  }, never, Scope.Scope>
}

const owner = Owner.make("kit-owner")
const answers = (...pieces: ReadonlyArray<string>) => ({ _tag: "Answers" as const, pieces })
const FIVE = [turnStartedEvent.name, userMessageEvent.name, requestSentEvent.name, assistantMessageEvent.name, turnEndedEvent.name]

/**
 * The loop contract as checks, each over a fresh loop and a scripted
 * model: a turn stores exactly `core.session.turn.started`,
 * `plugin.loop.user.message`, `plugin.loop.request.sent`,
 * `plugin.loop.assistant.message` and `core.session.turn.ended`, in
 * order, and returns the model's answer (`records`); the answer's pieces
 * are published live as `plugin.loop.assistant.delta` and stored nowhere
 * (`deltas`); the stored request is pointers that resolve, the turn's
 * message among them, and each message's text is in the journal once
 * (`request`); a model that fails still closes the turn with the failure,
 * and the next turn runs (`closes`); a turn asked for while one runs is
 * refused and stores nothing (`busy`).
 *
 * @public
 */
export const loopConformance = (subject: LoopSubject): ReadonlyArray<ConformanceCheck> => {
  type Parts = Effect.Success<ReturnType<LoopSubject["open"]>> & { readonly core: CoreShape }
  const check = (name: string, id: string, script: LoopScript, body: (parts: Parts) => Effect.Effect<void, { readonly _tag: string; readonly message: string }, Scope.Scope>): ConformanceCheck => ({
    id,
    name,
    run: Effect.scoped(Effect.gen(function* () {
      const core = Context.get(yield* Layer.build(kernel()), Core)
      yield* body({ core, ...(yield* subject.open(core, script)) })
    })).pipe(unexpected(id)),
  })
  const names = (events: ReadonlyArray<{ readonly name: string }>) => events.map((event) => event.name)

  return [
    check("a turn stores exactly five events, in order, and returns the answer", "records", [answers("Hel", "lo!")], ({ loop, sessions }) => Effect.gen(function* () {
      const session = yield* sessions.create({ owner })
      const reply = yield* loop.run({ session, message: "Hello" })
      yield* expect("records", reply.text === "Hello!", `the turn replied ${show(reply)}, not the model's answer`)
      const journal = yield* sessions.read(session)
      yield* expect("records", show(names(journal.events)) === show(FIVE), `one turn stored ${show(names(journal.events))}`)
      yield* expect("records", show(journal.events[1]?.message) === show({ _tag: "User", text: "Hello" }) && show(journal.events[3]?.message) === show({ _tag: "Assistant", text: "Hello!", toolCalls: [] }),
        `the turn's messages were stored as ${show(journal.events[1]?.message)} and ${show(journal.events[3]?.message)}`)
    })),
    check("the answer's pieces are published live and stored nowhere", "deltas", [answers("Hel", "lo", "!")], ({ core, loop, sessions }) => Effect.gen(function* () {
      const session = yield* sessions.create({ owner })
      const seen = yield* Ref.make<ReadonlyArray<KernelEvent>>([])
      yield* core.on(assistantDeltaEvent, (event) => Ref.update(seen, (all) => [...all, event]), { wait: true, name: "kit-watch" })
      const reply = yield* loop.run({ session, message: "Hello" })
      const deltas = yield* Ref.get(seen)
      const text = deltas.flatMap((event) => Option.toArray(dataOf(assistantDeltaEvent, event))).map((data) => data.text).join("")
      yield* expect("deltas", deltas.length === 3 && text === reply.text, `the pieces published were ${show(deltas.map((event) => event.data))}, the reply ${show(reply)}`)
      yield* expect("deltas", deltas.every((event) => event._tag === "Live" && event.session === session && event.turn === 1), `the pieces were published as ${show(deltas)}`)
      const journal = yield* sessions.read(session)
      yield* expect("deltas", journal.events.every((event) => event.name !== assistantDeltaEvent.name), "a piece of the answer was stored")
    })),
    check("the stored request is pointers that resolve, and each message is in the journal once", "request", [answers("One."), answers("Two.")], ({ loop, sessions }) => Effect.gen(function* () {
      const session = yield* sessions.create({ owner })
      yield* loop.run({ session, message: "The first question" })
      yield* loop.run({ session, message: "The second question" })
      const journal = yield* sessions.read(session)
      const requests = journal.events.flatMap((event) => Option.toArray(dataOf(requestSentEvent, event)))
      yield* expect("request", requests.length === 2, `two turns stored ${requests.length} requests`)
      const stored = journal.events.filter((event) => event.name === requestSentEvent.name)
      yield* Effect.forEach(stored, (event) => expect("request", Option.exists(dataOf(requestSentEvent, event), (request) => resolveRequest(journal.events, request, event.seq)._tag === "Success"),
        `the request stored at ${event.seq} does not resolve to earlier messages: ${show(event.data)}`), { concurrency: 1, discard: true })
      yield* expect("request", Option.exists(turnMessageOf(journal.events), (seq) => requests.at(-1)?.messages.includes(seq) === true),
        `the last request ${show(requests.at(-1)?.messages)} leaves out the message its turn answers`)
      const text = show(journal.events)
      const once = (message: string) => text.split(message).length - 1
      yield* expect("request", ["The first question", "The second question", "One.", "Two."].every((message) => once(message) === 1),
        `the journal holds a message's text more than once, or not at all: ${show(["The first question", "The second question", "One.", "Two."].map(once))}`)
    })),
    check("a model that fails still closes the turn, and the next turn runs", "closes", [{ _tag: "Fails" }, answers("Back.")], ({ loop, sessions }) => Effect.gen(function* () {
      const session = yield* sessions.create({ owner })
      yield* refuses("closes", "a turn whose model failed", loop.run({ session, message: "Hello" }), () => true)
      const journal = yield* sessions.read(session)
      const ended: Option.Option<{ readonly name: KernelEvent["name"]; readonly data: Schema.Json }> = Option.fromNullishOr(journal.events.at(-1))
      yield* expect("closes", Option.exists(Option.flatMap(ended, (event) => dataOf(turnEndedEvent, event)), (data) => data.outcome._tag === "Failed"),
        `a turn whose model failed left ${show(names(journal.events))}, ending with ${show(journal.events.at(-1)?.data)}`)
      const reply = yield* loop.run({ session, message: "Again" })
      const after = yield* sessions.read(session)
      yield* expect("closes", reply.text === "Back." && show(names(after.events).slice(journal.events.length)) === show(FIVE), `the turn after a failed one stored ${show(names(after.events).slice(journal.events.length))}`)
    })),
    check("a turn asked for while one runs is refused and stores nothing", "busy", [answers("Hi.")], ({ core, loop, sessions }) => Effect.gen(function* () {
      const session = yield* sessions.create({ owner })
      const refused = yield* Ref.make<ReadonlyArray<string>>([])
      yield* core.on(assistantDeltaEvent, () => Effect.matchEffect(loop.run({ session, message: "Me too" }), {
        onSuccess: () => Ref.update(refused, (all) => [...all, "ran"]),
        onFailure: (error) => Ref.update(refused, (all) => [...all, error._tag]),
      }), { wait: true, name: "kit-second" })
      yield* loop.run({ session, message: "Hello" })
      yield* expect("busy", show(yield* Ref.get(refused)) === show(["SessionRefused"]), `a turn asked for during a turn gave ${show(yield* Ref.get(refused))}`)
      const journal = yield* sessions.read(session)
      yield* expect("busy", show(names(journal.events)) === show(FIVE), `a refused turn left the journal as ${show(names(journal.events))}`)
    })),
  ]
}
