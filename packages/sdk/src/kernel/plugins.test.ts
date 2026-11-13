import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import type { Context } from "effect"
import { assistantMessage, Core, live, liveEvent, messageOf, originOf, Seq, Sessions, stored, storedEvent, userMessage } from "@xandreed/core/kernel"
import { Tokens } from "./contracts/memory/memory.entity.js"
import { estimateContext, promptMessage } from "./contracts/memory/memory.entity.functions.js"
import { Memory } from "./contracts/memory/memory.port.js"
import type { OpenSession } from "@xandreed/core/kernel"
import { answering, inOrder, open, recording, stack, SYSTEM as system } from "./testing.js"
import type { Turn } from "./testing.js"
const FOUR = ["core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "core.session.turn.ended"]

/*
 * A different turn, written here over the same contracts: it asks no model
 * and answers in capitals, with how many messages memory gave it. The
 * journal, session and memory layers are the stock ones, untouched.
 */
const shout: Turn = (conversation, message) => Effect.scoped(Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(conversation)
  yield* session.append(userMessage(message))
  const context = yield* (yield* Memory).context(session)
  const text = `${message.toUpperCase()} (${context.length})`
  yield* session.append(assistantMessage(text))
  return text
}))

describe("a different turn", () => {
  test("runs with the journal, session and memory layers untouched", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("never asked")
      const agent = yield* open(stack(model), shout)
      const session = yield* agent.createSession({ owner: "learner" })
      const replies = [yield* agent.send(session, "hello"), yield* agent.send(session, "again")]
      return { replies, inspection: yield* agent.inspect(session), received: yield* received }
    })))
    // The stock memory built the second context from what the other loop stored in the first turn: three messages.
    expect(result.replies).toEqual(["HELLO (1)", "AGAIN (3)"])
    expect(result.received).toEqual([])
    expect(result.inspection.events.map((event): string => event.name)).toEqual([...FOUR, ...FOUR])
    expect(result.inspection.state).toEqual({ _tag: "Free", turns: 2 })
  })
})

/*
 * A plugin adds an event on a compression check, and another plugin reacts
 * to it. Both events are defined here, in the test: nothing under
 * packages/core knows their names. `Core.publish`, `Core.on` and
 * `session.append` take them because the event type is open; were any of
 * the three typed with a list of core's own events, this file would not compile.
 */
const CompactionDue = Schema.Struct({ messages: Schema.Int, estimatedTokens: Tokens })
const compactionDue = liveEvent("compact", "due", { tags: ["memory"], data: CompactionDue })
/** The memory's summary: how many messages it stands for, and the run of the journal they are in, both ends included. The meaning is the plugin's, in its own data; it is the conversation's, and memory's own. */
const summaryWritten = storedEvent("compact", "summary", { tags: ["conversation", "memory"], data: Schema.Struct({ of: Schema.Int, from: Seq, through: Seq }), skippable: true })
const swept = liveEvent("janitor", "swept", { tags: ["trace"], data: Schema.Struct({ after: Schema.Int }) })

/** A memory that sends every message until there are more than `keep`, then says so, writes a summary of its own and sends that with the turn's message. */
const compactingMemory = (keep: number) => Layer.effect(Memory, Effect.gen(function* () {
  const core = yield* Core
  return Memory.of({
    context: (session) => Effect.gen(function* () {
      const journal = yield* session.journal
      const said = journal.flatMap((event) => event.name === summaryWritten.name ? [] : Option.toArray(Option.map(messageOf(event), (message) => ({ seq: event.seq, message }))))
      const all = said.map((entry) => promptMessage(entry.message))
      if (said.length <= keep) return all
      // The compression check tripped: announce it, live, under this plugin's own name.
      yield* core.publish(live(compactionDue, session, { messages: said.length, estimatedTokens: estimateContext(all) }))
      const older = said.slice(0, -1)
      const last = said.at(-1)
      const first = older[0]
      const through = older.at(-1)
      if (last === undefined || first === undefined || through === undefined) return all
      // Text memory writes for the model is its own record first, bearing the message, with what it replaces in its own data.
      const summary = yield* session.append(stored(summaryWritten, { of: older.length, from: first.seq, through: through.seq }, {
        message: { _tag: "User", text: `Summary of ${older.length} earlier messages.` },
      }))
      return [...Option.toArray(messageOf(summary)), last.message].map(promptMessage)
    }),
  })
}))

/** Whether an event is stored or only published is in its type: this compiles only because the two wrong calls are marked as errors. */
const kindsAreTypes = (core: Context.Service.Shape<typeof Core>, session: OpenSession) => [
  session.append(stored(summaryWritten, { of: 1, from: Seq.make(1), through: Seq.make(1) })),
  core.publish(live(compactionDue, session, { messages: 1, estimatedTokens: Tokens.make(1) })),
  // @ts-expect-error a live event is not appended to the journal
  session.append(live(compactionDue, session, { messages: 1, estimatedTokens: Tokens.make(1) })),
  // @ts-expect-error a draft is not published before it is stored
  core.publish(stored(summaryWritten, { of: 1, from: Seq.make(1), through: Seq.make(1) })),
]

describe("a plugin adds an event on a compression check and another plugin reacts", () => {
  test("type-level: whether its events are stored or live is checked by the compiler", () => {
    expect(kindsAreTypes).toBeFunction()
  })


  test("with no change in core", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Fine.")
      const sweeps = yield* Ref.make<ReadonlyArray<number>>([])
      // The second plugin: it listens for the first one's event and acts, here by counting and by publishing an event of its own.
      const janitor = Layer.effectDiscard(Effect.gen(function* () {
        const core = yield* Core
        yield* core.on(compactionDue, (due) => Effect.andThen(
          Ref.update(sweeps, (all) => [...all, due.data.messages]),
          core.publish(live(swept, originOf(due), { after: due.data.messages })),
        ), { wait: true, name: "janitor" })
      }))
      const record = yield* recording([compactionDue, swept, summaryWritten])
      const agent = yield* open(stack(model, { memory: compactingMemory(3), extras: inOrder(record.layer, janitor) }))
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "One")
      const quiet = yield* record.names
      yield* agent.send(session, "Two")
      yield* agent.send(session, "Three")
      return { quiet, seen: yield* record.seen, sweeps: yield* Ref.get(sweeps), inspection: yield* agent.inspect(session), received: yield* received }
    })))
    expect(result.quiet).toEqual([])
    // The check tripped on the third turn (five messages over a limit of three): the event, the reaction to it, then the summary's own record.
    expect(result.seen.map((event) => `${event._tag} ${event.name}`)).toEqual(["Live plugin.compact.due", "Live plugin.janitor.swept", "Stored plugin.compact.summary"])
    expect(result.seen[0]?.data).toEqual({ messages: 5, estimatedTokens: 8 })
    expect(result.sweeps).toEqual([5])
    // The summary is stored once, as the plugin's record bearing a message, tagged as the conversation's and memory's own.
    const summary = result.inspection.events.find((event) => event.name === "plugin.compact.summary")
    expect(summary).toMatchObject({ skippable: true, tags: ["conversation", "memory"], data: { of: 4, from: 2, through: 7 }, message: { _tag: "User", text: "Summary of 4 earlier messages." } })
    expect(result.received.at(-1)).toEqual([
      { role: "system", text: system },
      { role: "user", text: "Summary of 4 earlier messages." },
      { role: "user", text: "Three" },
    ])
  })
})
