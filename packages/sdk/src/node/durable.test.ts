import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { dataOf, JOURNAL_FORMAT, JournalStorage, kernel, Owner, Seq, SessionId, Sessions, turnEndedEvent, turnStarted, TurnNumber } from "@xandreed/core"
import { flatMemory, recoverTurns, sessions, turnsOf } from "../index.js"
import { counting, testTurn } from "../testing.js"
import { directoryJournal, sqliteJournal } from "./index.js"
import { holder, killed, scratch } from "./testing.js"
import type { StoreAt } from "./testing.js"

/*
 * The kernel over a store that outlives its process, on each of the two
 * durable journals: a host's program runs real turns over it, and a process
 * killed inside a turn (a real one, `SIGKILL`) leaves the turn open until the
 * next process takes the store over and recovers it.
 */

// #region durable
/**
 * A host's stack over a directory of files. The store is taken as the layer is
 * built: it fails with `JournalOpenFailed` while another live process holds
 * it, and takes it over from one whose process is gone. `sqliteJournal({ path })`
 * is the same over one SQLite file.
 */
const over = (directory: string) => sessions().pipe(
  Layer.provideMerge(directoryJournal({ directory })),
  Layer.provideMerge(kernel()),
)

/**
 * Go on with a conversation of the store. First, before any turn: every turn
 * the store holds open was a writer's that is gone, since no other process can
 * hold the store, so `recoverTurns` closes each as `Abandoned`. A session the
 * store cannot read (a damaged line) is passed over and named in `unreadable`:
 * the host repairs or removes it, and the others are recovered all the same.
 */
const goOn = (directory: string, conversation: SessionId) => Effect.gen(function* () {
  const { closed, unreadable } = yield* recoverTurns
  const turns = yield* Sessions
  const turn = yield* turns.turn(conversation, (session) => Effect.succeed(session.turn))
  return { closed: closed.length, unreadable: unreadable.map((one) => one.session), turn }
}).pipe(Effect.provide(over(directory)))
// #endregion durable

const stores: ReadonlyArray<{ readonly kind: "directory" | "sqlite"; readonly file: string; readonly store: StoreAt }> = [
  { kind: "directory", file: "journal", store: (path) => directoryJournal({ directory: path }) },
  { kind: "sqlite", file: "journal.db", store: (path) => sqliteJournal({ path }) },
]

/** A process over a store: the guide's stack over it, flat memory and a model that counts its replies. */
const processOn = (store: StoreAt, path: string) => Effect.flatMap(counting, ({ model, received }) => Effect.succeed({
  layer: flatMemory.pipe(Layer.provideMerge(sessions().pipe(Layer.provideMerge(store(path)), Layer.provideMerge(kernel()))), Layer.provideMerge(model)),
  received,
}))

const outcomesOf = (events: ReadonlyArray<Parameters<typeof dataOf>[1]>) =>
  events.flatMap((event) => Option.match(dataOf(turnEndedEvent, event), { onNone: () => [], onSome: (data) => [data.outcome._tag] }))

describe("the guide's stack over a directory", () => {
  test("starts up over a store a killed process left a turn open in, closes it, and goes on", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = join(yield* scratch, "journal")
      const { child, line } = yield* holder("directory", directory, "turn")
      yield* killed(child)
      const session = SessionId.make(JSON.parse(line).session)
      const went = yield* goOn(directory, session)
      const journal = yield* Effect.provide(Effect.flatMap(Sessions, (all) => all.read(session)), over(directory))
      return { ...went, turn: Number(went.turn), outcomes: outcomesOf(journal.events) }
    })))
    expect(result).toEqual({ closed: 1, unreadable: [], turn: 2, outcomes: ["Abandoned", "Completed"] })
  }, 30_000)

  test("a session with a damaged line is passed over and named; the turn left open in the session after it is closed", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = join(yield* scratch, "journal")
      // Two sessions, the damaged one first in the listing, each with a turn its writer left open.
      const [damaged, open] = yield* Effect.scoped(Effect.gen(function* () {
        const storage = yield* JournalStorage
        const ids = [SessionId.make("a-damaged"), SessionId.make("b-open")] as const
        yield* Effect.forEach(ids, (id, index) => Effect.andThen(
          storage.create({ id, owner: Owner.make("learner"), createdAt: index, format: JOURNAL_FORMAT }),
          storage.append(id, Seq.make(0), TurnNumber.make(1), turnStarted(TurnNumber.make(1))),
        ), { concurrency: 1, discard: true })
        return ids
      }).pipe(Effect.provide(over(directory))))
      // A byte of the damaged session's event line changed on the disk: its CRC-32 no longer matches.
      const file = join(directory, "sessions", `${damaged}.jsonl`)
      const text = yield* Effect.promise(() => readFile(file, "utf8"))
      yield* Effect.promise(() => writeFile(file, text.replace("turn.started", "turn.storted")))
      const went = yield* goOn(directory, open)
      return { ...went, turn: Number(went.turn) }
    })))
    expect<unknown>(result).toEqual({ closed: 1, unreadable: ["a-damaged"], turn: 2 })
  }, 30_000)
})

for (const { kind, file, store } of stores) describe(`the ${kind} journal under the kernel`, () => {
  test("a process killed inside a turn leaves it open; the next one takes the store over, recovers the turn as abandoned, and takes a new turn", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = join(yield* scratch, file)
      const { child, line } = yield* holder(kind, path, "turn")
      yield* killed(child)
      const session = SessionId.make(JSON.parse(line).session)
      const next = yield* processOn(store, path)
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const busy = yield* Effect.flip(all.turn(session, () => Effect.void))
        const closed = yield* recoverTurns
        const again = yield* recoverTurns
        const answer = yield* testTurn()(session, "Hello again.")
        const journal = yield* all.read(session)
        return {
          busy: busy.message,
          closed: closed.closed.map((one) => [one.session === session, Number(one.turn)]),
          again,
          answer,
          outcomes: outcomesOf(journal.events),
          said: turnsOf(journal.events).map((turn) => turn.messages.map((message) => message.text)),
          sent: (yield* next.received).at(-1)?.map((message) => message.text),
        }
      }).pipe(Effect.provide(next.layer))
    })))
    expect(result).toEqual({
      busy: "turn 1 is still open: if the writer that opened it is gone, close it with `Sessions.recover`",
      closed: [[true, 1]],
      again: { closed: [], unreadable: [] },
      answer: "Reply 1.",
      outcomes: ["Abandoned", "Completed"],
      said: [["Are you there?"], ["Hello again."]],
      sent: ["You are a friendly tutor.", "Are you there?", "Hello again."],
    })
  }, 30_000)

  test("a host's program runs turns over the store, and the next process reads them back and goes on with what was said", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = join(yield* scratch, file)
      const first = yield* processOn(store, path)
      const session = yield* Effect.scoped(Effect.gen(function* () {
        const all = yield* Sessions
        const conversation = yield* all.create({ owner: "learner" })
        yield* testTurn()(conversation, "My name is Ana.")
        yield* testTurn()(conversation, "What is my name?")
        return conversation
      }).pipe(Effect.provide(first.layer)))
      const second = yield* processOn(store, path)
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const closed = yield* recoverTurns
        const before = turnsOf((yield* all.read(session)).events).map((turn) => [turn.messages.map((message) => message.text), Option.getOrUndefined(turn.answer)])
        yield* testTurn()(session, "And now?")
        return { closed, before, sent: (yield* second.received).at(-1)?.map((message) => message.text), listed: (yield* all.list).length }
      }).pipe(Effect.provide(second.layer))
    })))
    expect(result).toEqual({
      closed: { closed: [], unreadable: [] },
      before: [[["My name is Ana."], "Reply 1."], [["What is my name?"], "Reply 2."]],
      sent: ["You are a friendly tutor.", "My name is Ana.", "Reply 1.", "What is my name?", "Reply 2.", "And now?"],
      listed: 1,
    })
  }, 30_000)
})
