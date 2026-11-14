import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Option, Result } from "effect"
import { currentFormat, dataOf, kernel, Sessions, turnEndedEvent, userMessage } from "@xandreed/core/kernel"
import { sessions, webStorageJournal } from "./index.js"
import type { KeyValueStore } from "./index.js"

/*
 * A store that outlives the process that wrote to it: the web storage
 * journal over a value that stands for a browser's `localStorage`. One
 * "process" is one stack built over a view of that value; a view can be
 * severed, after which its writer can do nothing more, as a page that was
 * closed. The host's own part is `resume`: which conversation to go on
 * with, and the close of a turn nobody will close.
 */

/** What stands for the browser's storage: strings by key, kept for the whole test. */
const storageOf = (): KeyValueStore => {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index) => Array.from(values.keys())[index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

/** A page's view of the storage, and how the test closes that page: every call of a severed view throws. */
const viewOf = (storage: KeyValueStore) => {
  let open = true
  /** A closed page's storage does what a browser's does when it will not serve a call: it throws. */
  const live = <A>(run: () => A): A => open ? run() : Result.getOrThrowWith(Result.fail("this page is closed"), (why) => new Error(why))
  const view: KeyValueStore = {
    get length() { return live(() => storage.length) },
    key: (index) => live(() => storage.key(index)),
    getItem: (key) => live(() => storage.getItem(key)),
    setItem: (key, value) => live(() => storage.setItem(key, value)),
    removeItem: (key) => live(() => storage.removeItem(key)),
  }
  return { view, close: () => { open = false } }
}

/** One process: the kernel, the session plugin and a journal in the storage it was given. */
const processOver = (storage: KeyValueStore) =>
  sessions().pipe(Layer.provideMerge(webStorageJournal(storage, { prefix: "agent:" })), Layer.provideMerge(kernel()))

// #region resume
/**
 * The conversation to go on with: the last one this owner started that this
 * kernel reads, or a new one. This host is the store's one writer and has
 * just started, so a turn the journal holds open is nobody's: `recover`
 * closes it as `Abandoned`, and does nothing to a session that is free.
 */
const resume = (owner: string) => Effect.gen(function* () {
  const sessions = yield* Sessions
  const mine = (yield* sessions.list).filter((header) =>
    header.owner === owner && header.parent === undefined && Result.isSuccess(currentFormat(header)))
  const last = mine.at(-1)
  if (last === undefined) return yield* sessions.create({ owner })
  yield* sessions.recover(last.id)
  return last.id
})
// #endregion resume

describe("a conversation in a store that outlives its process", () => {
  test("is found again by the next process, with the turn its writer left open closed as abandoned, and goes on", async () => {
    const storage = storageOf()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // The first page: one whole turn, then a turn it is still in when it is closed.
      const first = viewOf(storage)
      const begun = yield* Effect.gen(function* () {
        const all = yield* Sessions
        const conversation = yield* resume("learner")
        yield* all.turn(conversation, (session) => session.append(userMessage("My name is Ana.")))
        const inside = yield* Deferred.make<void>()
        yield* Effect.forkScoped(all.turn(conversation, (session) =>
          Effect.andThen(session.append(userMessage("What is my name?")), Effect.andThen(Deferred.succeed(inside, undefined), Effect.never))))
        yield* Deferred.await(inside)
        return conversation
      }).pipe(Effect.provide(processOver(first.view)))
      first.close()

      // The next page, over the same storage.
      return yield* Effect.gen(function* () {
        const all = yield* Sessions
        const busy = yield* Effect.flip(all.turn(begun, () => Effect.void))
        const conversation = yield* resume("learner")
        const number = yield* all.turn(conversation, (session) => Effect.as(session.append(userMessage("Are you there?")), Number(session.turn)))
        const journal = yield* all.read(conversation)
        const outcomes = journal.events.flatMap((event) => Option.match(dataOf(turnEndedEvent, event), { onNone: () => [], onSome: (data) => [data.outcome._tag] }))
        return { same: conversation === begun, busy: busy.message, number, outcomes, said: journal.events.flatMap((event) => event.message?._tag === "User" ? [event.message.text] : []), listed: (yield* all.list).length }
      }).pipe(Effect.provide(processOver(storage)))
    })).pipe(Effect.timeout("5 seconds")))

    expect(result.same).toBe(true)
    expect(result.busy).toBe("turn 2 is still open: if the writer that opened it is gone, close it with `Sessions.recover`")
    expect(result.outcomes).toEqual(["Completed", "Abandoned", "Completed"])
    expect(result.number).toBe(3)
    expect(result.said).toEqual(["My name is Ana.", "What is my name?", "Are you there?"])
    expect(result.listed).toBe(1)
  })

  test("a session of another owner, a helper's, or one this kernel cannot read is not the one to go on with", async () => {
    const storage = storageOf()
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const all = yield* Sessions
      const other = yield* all.create({ owner: "somebody else" })
      const mine = yield* all.create({ owner: "learner" })
      const helper = yield* all.create({ owner: "learner", parent: mine })
      // A session a later kernel wrote: its header says so, and it is listed.
      const later = "agent:from-a-later-kernel:header"
      storage.setItem(later, (storage.getItem(`agent:${mine}:header`) ?? "").replace(`"${mine}"`, '"from-a-later-kernel"').replace(/"format":\d+/, '"format":99').replace(/"createdAt":\d+/, '"createdAt":9999999999999'))
      const resumed = yield* resume("learner")
      return { resumed: resumed === mine, others: [other, helper].includes(resumed), listed: (yield* all.list).map((header) => header.format) }
    }).pipe(Effect.provide(processOver(storage)))).pipe(Effect.timeout("5 seconds")))
    expect(result).toEqual({ resumed: true, others: false, listed: [2, 2, 2, 99] })
  })
})
