import { describe, expect, test } from "bun:test"
import { Effect, Option, Ref, Schema } from "effect"
import type { Context } from "effect"
import {
  assistantMessage,
  Core,
  definePlugin,
  estimateRequest,
  firstStep,
  live,
  liveEvent,
  Loop,
  Memory,
  messageOf,
  replyOf,
  requestSent,
  Sessions,
  Settings,
  stored,
  storedEvent,
  Tokens,
  userMessage,
} from "@xandreed/core/kernel"
import type { AssistantMessage, OpenSession } from "@xandreed/core/kernel"
import { Agent, inMemoryStorage, sessions, windowMemory } from "./index.js"
import { answering, recording } from "./testing.js"

const system = "You are a friendly tutor."
const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

/*
 * A different loop plugin, written here on the same contracts: it asks no
 * model and answers in capitals. The storage, session and memory plugins
 * are the stock ones, untouched.
 */
const shoutLoop = () => definePlugin({
  name: "loop",
  requires: [Sessions, Memory, Settings],
  provides: Loop,
  make: Effect.gen(function* () {
    const turns = yield* Sessions
    const memory = yield* Memory
    const settings = yield* Settings
    return Loop.of({
      run: (input) => turns.turn(input.session, (session) => Effect.gen(function* () {
        yield* session.append(userMessage(input.message))
        const request = yield* (yield* memory.open(session)).build(firstStep)
        yield* session.append(requestSent(firstStep, settings.system, request))
        const message: AssistantMessage = { _tag: "Assistant", text: input.message.toUpperCase(), toolCalls: [] }
        yield* session.append(assistantMessage(firstStep, message))
        return replyOf(message)
      })),
    })
  }),
})

describe("a different loop plugin", () => {
  test("runs with the storage, session and memory plugins untouched", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("never asked")
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), sessions: sessions(), memory: windowMemory({ budgetTokens: 3000 }), loop: shoutLoop() })
      const session = yield* agent.createSession({ owner: "learner" })
      const replies = [yield* agent.send(session, "hello"), yield* agent.send(session, "again")]
      return { replies, inspection: yield* agent.inspect(session), received: yield* received }
    })))
    expect(result.replies).toEqual([{ text: "HELLO" }, { text: "AGAIN" }])
    // What this loop declared that it needs: no model and no `Core`, unlike the stock one.
    expect(shoutLoop().requires).toEqual([Sessions.key, Memory.key, Settings.key])
    expect(shoutLoop().provides).toBe(Loop.key)
    expect(result.received).toEqual([])
    expect(result.inspection.events.map((event): string => event.name)).toEqual([...FIVE, ...FIVE])
    expect(result.inspection.state).toEqual({ _tag: "Free", turns: 2 })
    // The stock memory built the second request from what the other loop stored in the first turn.
    expect(result.inspection.requests[1]?.messages.map(({ message }) => message.text)).toEqual(["hello", "HELLO", "again"])
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
const compactionDue = liveEvent("compact", "due", { data: CompactionDue })
const summaryWritten = storedEvent("compact", "summary", { data: Schema.Struct({ of: Schema.Int }), skippable: true })
const swept = liveEvent("janitor", "swept", { data: Schema.Struct({ after: Schema.Int }) })

/** A memory that sends every message until there are more than `keep`, then says so, writes a summary of its own and sends that with the turn's message. */
const compactingMemory = (keep: number) => definePlugin({
  name: "compact",
  requires: [Core, Settings],
  provides: Memory,
  make: Effect.gen(function* () {
    const core = yield* Core
    const settings = yield* Settings
    const budgetTokens = Tokens.make(3000)
    return Memory.of({
      open: (session) => Effect.succeed({
        build: () => Effect.gen(function* () {
          const journal = yield* session.journal
          const bearing = journal.filter((event) => event.message !== undefined && event.name !== summaryWritten.name)
          const estimate = (seqs: ReadonlyArray<number>) => estimateRequest(settings.system, journal.filter((event) => seqs.includes(event.seq)).flatMap((event) => event.message === undefined ? [] : [event.message]))
          const all = bearing.map((event) => event.seq)
          if (bearing.length <= keep) return { messages: all, estimatedTokens: estimate(all), budgetTokens }
          // The compression check tripped: announce it, live, under this plugin's own name.
          yield* core.publish(live(compactionDue, session, { messages: bearing.length, estimatedTokens: estimate(all) }))
          const older = bearing.slice(0, -1)
          const last = bearing.at(-1)
          const first = older[0]
          const through = older.at(-1)
          if (last === undefined || first === undefined || through === undefined) return { messages: all, estimatedTokens: estimate(all), budgetTokens }
          // Text memory writes for the model is its own record first, bearing the message and naming what it replaces; the request points at it.
          const summary = yield* session.append(stored(summaryWritten, { of: older.length }, {
            message: { _tag: "User", text: `Summary of ${older.length} earlier messages.` },
            replaces: { from: first.seq, through: through.seq },
          }))
          const estimatedTokens = estimateRequest(settings.system, [...Option.toArray(messageOf(summary)), ...Option.toArray(messageOf(last))])
          return { messages: [summary.seq, last.seq], estimatedTokens, budgetTokens }
        }),
      }),
    })
  }),
})

/** Whether an event is stored or only published is in its type: this compiles only because the two wrong calls are marked as errors. */
const kindsAreTypes = (core: Context.Service.Shape<typeof Core>, session: OpenSession) => [
  session.append(stored(summaryWritten, { of: 1 })),
  core.publish(live(compactionDue, session, { messages: 1, estimatedTokens: Tokens.make(1) })),
  // @ts-expect-error a live event is not appended to the journal
  session.append(live(compactionDue, session, { messages: 1, estimatedTokens: Tokens.make(1) })),
  // @ts-expect-error a draft is not published before it is stored
  core.publish(stored(summaryWritten, { of: 1 })),
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
      const janitor = definePlugin({
        name: "janitor",
        requires: [Core],
        make: Effect.gen(function* () {
          const core = yield* Core
          yield* core.on(compactionDue, (due) => Effect.andThen(
            Ref.update(sweeps, (all) => [...all, due.data.messages]),
            core.publish(live(swept, { id: due.session, turn: due.turn }, { after: due.data.messages })),
          ), { wait: true })
        }),
      })
      const record = yield* recording([compactionDue, swept, summaryWritten])
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: compactingMemory(3), plugins: [record.plugin, janitor] })
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
    expect(result.seen[0]?.data).toEqual({ messages: 5, estimatedTokens: 15 })
    expect(result.sweeps).toEqual([5])
    // The summary is stored once, as the plugin's record bearing a message, and the request points at it.
    const summary = result.inspection.events.find((event) => event.name === "plugin.compact.summary")
    expect(summary).toMatchObject({ skippable: true, data: { of: 4 }, message: { _tag: "User", text: "Summary of 4 earlier messages." }, replaces: { from: 2, through: 9 } })
    const last = result.inspection.requests.at(-1)
    expect(last?.messages.map((pointed): number => pointed.seq)).toEqual([13, 12])
    expect(result.received.at(-1)).toEqual([
      { role: "system", text: system },
      { role: "user", text: "Summary of 4 earlier messages." },
      { role: "user", text: "Three" },
    ])
  })
})
