import { describe, expect, test } from "bun:test"
import { Clock, Effect, Layer, Queue, Ref, Schema } from "effect"
import type { Prompt } from "effect/ai"
import { assistantMessageEvent, Core, stored, storedEvent, turnEndedEvent, userMessage } from "@xandreed/core/kernel"
import type { StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens, flatMemory, Memory, memoryWrapperConformance, messageText } from "./index.js"
import { answering, counting, open, stack } from "./testing.js"

// A plugin of your own, the two ways the second lesson's program grows by
// (docs/kernel.md, "A plugin of your own"; ADR 0005): an event plugin that
// observes, and a wrapper of a contract that adds to what it returns.

const failedChecks = (checks: ReadonlyArray<{ readonly id: string; readonly run: Effect.Effect<void, unknown> }>) =>
  Effect.runPromise(Effect.forEach(checks, (one) => Effect.match(one.run, { onFailure: () => [one.id], onSuccess: () => [] }), { concurrency: 1 }).pipe(Effect.map((ids) => ids.flat())))

// #region meter
/**
 * An event plugin. On boot it hooks two events, as a Neovim autocmd does: each
 * answer stored, and each turn's end. It stores nothing and says nothing to the
 * model: it counts, and shows the count. The listener registered with
 * `wait: true` holds the turn until it returns, and its failure would fail the
 * turn; the other runs in the background. Its listeners go with its layer's scope.
 */
const meter = (show: (line: string) => Effect.Effect<void>) =>
  Layer.effectDiscard(Effect.gen(function* () {
    const core = yield* Core
    const spent = yield* Ref.make({ turn: 0, total: 0 })

    // Each answer: what the provider says it cost, else an estimate of its text. `wait: true`, so the
    // count is in before the turn goes on, and so before its end is announced.
    yield* core.on(assistantMessageEvent, (event) => {
      const said = "message" in event && event.message !== undefined ? messageText(event.message) : ""
      const tokens = event.data.usage?.outputTokens ?? estimateTokens(said)
      return Ref.update(spent, ({ turn, total }) => ({ turn: turn + tokens, total: total + tokens }))
    }, { name: "meter", wait: true })

    // Each turn's end: show what it cost, and start the next turn's count at zero.
    yield* core.on(turnEndedEvent, (event) =>
      Effect.flatMap(Ref.getAndUpdate(spent, (count) => ({ ...count, turn: 0 })), ({ turn, total }) =>
        show(`turn ${event.data.turn}: ${turn} tok, ${total} in all`)), { name: "meter" })
  }))
// #endregion meter

// #region clock
/**
 * A wrapper of `Memory`, written as a higher-order plugin: given the memory it
 * wraps, it returns a memory. It asks the one below for the context, then adds
 * one message after it, for this request only. The time is computed here, like
 * the system text, and never stored: the next request has its own, and the
 * cached prefix up to the conversation's end still holds.
 */
const withClock = <E, R>(inner: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R> =>
  Layer.effect(Memory, Effect.gen(function* () {
    const memory = yield* Memory // the memory it wraps
    return Memory.of({
      context: (session) => Effect.gen(function* () {
        const context = yield* memory.context(session)
        const now = new Date(yield* Clock.currentTimeMillis).toISOString().slice(11, 16)
        return [...context, { role: "user" as const, content: `[Host note: it is ${now} UTC.]` }]
      }),
    })
  })).pipe(Layer.provide(inner))
// #endregion clock

const texts = (received: ReadonlyArray<ReadonlyArray<{ readonly role: string; readonly text: string }>>) => received.map((prompt) => prompt.map((message) => `${message.role}: ${message.text}`))

describe("a plugin of your own", () => {
  test("an event plugin counts each turn's answer and shows it at the turn's end, storing nothing", async () => {
    const shown = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // The turn's end reaches the meter in the background: the test waits for each line it shows.
      const lines = yield* Queue.bounded<string>(8)
      const model = yield* answering("Hello there, friend.")
      const agent = yield* open(stack(model.model, { memory: flatMemory, extras: meter((line) => Effect.asVoid(Queue.offer(lines, line))) }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hi.")
      const first = yield* Queue.take(lines)
      yield* agent.send(session, "Hi again.")
      const second = yield* Queue.take(lines)
      const journal = yield* agent.inspect(session)
      return { lines: [first, second], names: journal.events.map((event): string => event.name) }
    })))
    // The scripted model reports 3 output tokens for each answer: the meter takes what the provider says over its estimate.
    const each = 3
    expect(each).not.toBe(estimateTokens("Hello there, friend."))
    expect(shown.lines).toEqual([`turn 1: ${each} tok, ${each} in all`, `turn 2: ${each} tok, ${2 * each} in all`])
    // What the turns stored is the conversation and the turns' bounds: the meter stored nothing.
    expect(shown.names).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended",
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended",
    ])
  })

  test("a wrapper adds the time after the context, for each request, and stores nothing", async () => {
    const seen = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* counting
      const agent = yield* open(stack(model.model, { memory: withClock(flatMemory) }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hi.")
      yield* agent.send(session, "And now?")
      return { received: texts(yield* model.received), journal: (yield* agent.inspect(session)).events }
    })))
    expect(seen.received[1]?.slice(0, -1)).toEqual(["system: You are a friendly tutor.", "user: Hi.", "assistant: Reply 1.", "user: And now?"])
    expect(seen.received[1]?.at(-1)).toMatch(/^user: \[Host note: it is \d\d:\d\d UTC\.\]$/)
    expect(seen.journal.flatMap((event: StoredEvent) => (event.message === undefined ? [] : [messageText(event.message)]))).toEqual(["Hi.", "Reply 1.", "And now?", "Reply 2."])
  })

  test("the clock stored as a plugin's record never reaches the flat memory; stored as a user message, it does, and piles up", async () => {
    const clockEvent = storedEvent("clock", "now", { data: Schema.Struct({ at: Schema.String }), skippable: true, tags: ["memory"] })
    const storing = (asUser: boolean) => <E, R>(inner: Layer.Layer<Memory, E, R>): Layer.Layer<Memory, E, R> =>
      Layer.effect(Memory, Effect.gen(function* () {
        const memory = yield* Memory
        return Memory.of({
          context: (session) => Effect.andThen(
            session.append(asUser ? userMessage("[Host note: it is 00:00 UTC.]") : stored(clockEvent, { at: "00:00" })),
            memory.context(session),
          ),
        })
      })).pipe(Layer.provide(inner))
    const lastPrompt = (asUser: boolean) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* counting
      const agent = yield* open(stack(model.model, { memory: storing(asUser)(flatMemory) }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "Hi.")
      yield* agent.send(session, "And now?")
      return texts(yield* model.received).at(-1)
    })))
    expect((await lastPrompt(false))?.filter((line) => line.includes("Host note"))).toEqual([])
    expect((await lastPrompt(true))?.filter((line) => line.includes("Host note"))).toEqual(["user: [Host note: it is 00:00 UTC.]", "user: [Host note: it is 00:00 UTC.]"])
  })

  test("the clock passes the wrapper kit; careless wrappers fail the checks of what they are careless about, and between them every check", async () => {
    type Context = ReadonlyArray<Prompt.MessageEncoded>
    const note: Prompt.MessageEncoded = { role: "user", content: "[Host note: it is 00:00 UTC.]" }
    /** A careless wrapper: it edits what the memory below returned, and may store its note as something said. */
    const careless = (edit: (context: Context) => Context, store: boolean) => (inner: Layer.Layer<Memory>): Layer.Layer<Memory, never, Core> =>
      Layer.effect(Memory, Effect.gen(function* () {
        const memory = yield* Memory
        return Memory.of({
          context: (session) => Effect.gen(function* () {
            if (store) yield* session.append(userMessage("[Host note: it is 00:00 UTC.]"))
            return edit(yield* memory.context(session))
          }),
        })
      })).pipe(Layer.provide(inner))
    expect(await failedChecks(memoryWrapperConformance({ name: "clock", wrap: withClock }))).toEqual([])
    expect(await failedChecks(memoryWrapperConformance({ name: "first", wrap: careless((context) => [note, ...context], false) }))).toEqual(["starts-with-inner"])
    expect(await failedChecks(memoryWrapperConformance({ name: "dropping", wrap: careless((context) => context.slice(1), false) }))).toEqual(["starts-with-inner"])
    expect(await failedChecks(memoryWrapperConformance({ name: "storing", wrap: careless((context) => [...context, note], true) }))).toEqual(["own-records"])
  })
})
