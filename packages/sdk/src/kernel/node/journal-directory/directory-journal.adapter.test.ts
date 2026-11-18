import { describe, expect, test } from "bun:test"
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { JOURNAL_FORMAT, journalStorageConformance, Owner, Seq, SessionId, sessionsConformance, stored, storedEvent, TurnNumber, userMessage } from "@xandreed/core/kernel"
import { failedChecks, scratch, sessionsSubject, storageAt, storageSubject } from "../testing.js"
import { directoryJournal } from "./directory-journal.adapter.js"
import { DIRECTORY_LAYOUT, DIRECTORY_STORE } from "./directory-journal.entity.js"
import { fileNameOf } from "./directory-journal.entity.functions.js"

/*
 * The directory journal: the kernel's kits over it, and what a directory
 * holds after a crash, a damaged line or another store's files.
 */

const store = (directory: string) => directoryJournal({ directory })
const header = { id: SessionId.make("s-1"), owner: Owner.make("learner"), createdAt: 1, format: JOURNAL_FORMAT }
const noted = storedEvent("kit", "noted", { data: Schema.Json, skippable: true, tags: ["kit.noted"] })
const turn = TurnNumber.make(1)

describe("the directory journal", () => {
  test("passes the storage kit, a second handle of the process on the same directory included", async () => {
    const checks = journalStorageConformance(storageSubject(store, "journal"))
    expect(checks.map((check) => check.id)).toContain("reopens")
    expect(await failedChecks(checks)).toEqual([])
  })

  test("passes the sessions kit under the stock session plugin", async () => {
    expect(await failedChecks(sessionsConformance(sessionsSubject(store, "journal")))).toEqual([])
  })

  test("a store opened again reads what the one before wrote, and goes on from it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = join(yield* scratch, "journal")
      yield* Effect.scoped(Effect.gen(function* () {
        const first = yield* storageAt(store, directory)
        yield* first.create(header)
        yield* first.append(header.id, Seq.make(0), turn, userMessage("Hello"))
      }))
      const second = yield* storageAt(store, directory)
      const next = yield* second.append(header.id, Seq.make(1), turn, userMessage("Again"))
      const read = yield* second.read(header.id)
      return { next: Number(next.seq), said: read.events.map((event) => event.message?._tag === "User" ? event.message.text : ""), listed: (yield* second.list).map((one): string => one.id) }
    })))
    expect(result).toEqual({ next: 2, said: ["Hello", "Again"], listed: ["s-1"] })
  })

  test("a line a crash left unfinished is never read: a read leaves it out, and the next append cuts it before it writes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = join(yield* scratch, "journal")
      const file = join(directory, "sessions", fileNameOf(header.id))
      yield* Effect.scoped(Effect.gen(function* () {
        const first = yield* storageAt(store, directory)
        yield* first.create(header)
        yield* first.append(header.id, Seq.make(0), turn, stored(noted, { n: 1 }))
      }))
      // What a write stopped half way leaves: the start of a line, with no line break.
      const whole = yield* Effect.promise(() => readFile(file))
      yield* Effect.promise(() => appendFile(file, '8c1e0f3a {"seq":2,"at":1,"turn":1,"name":"plugin.kit.no'))
      const storage = yield* storageAt(store, directory)
      const before = yield* storage.read(header.id)
      const conflict = yield* Effect.flip(storage.append(header.id, Seq.make(2), turn, stored(noted, { n: 2 })))
      const appended = yield* storage.append(header.id, Seq.make(1), turn, stored(noted, { n: 2 }))
      const after = yield* storage.read(header.id)
      const bytes = yield* Effect.promise(() => readFile(file))
      return {
        before: before.events.map((event): number => event.seq),
        conflict: conflict.reason,
        appended: Number(appended.seq),
        after: after.events.map((event) => event.data),
        cut: bytes.subarray(0, whole.length).equals(whole) && bytes.toString("utf8").split("\n").length === 4,
      }
    })))
    expect(result).toEqual({ before: [1], conflict: "SeqConflict", appended: 2, after: [{ n: 1 }, { n: 2 }], cut: true })
  })

  test("a whole line that is not the line written is damage: the session is refused at that line, never read past it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = join(yield* scratch, "journal")
      const storage = yield* storageAt(store, directory)
      yield* storage.create(header)
      yield* Effect.forEach([0, 1, 2], (at) => storage.append(header.id, Seq.make(at), turn, stored(noted, { n: at })), { concurrency: 1, discard: true })
      const file = join(directory, "sessions", fileNameOf(header.id))
      const text = yield* Effect.promise(() => readFile(file, "utf8"))
      // One character of the second event changed: its CRC-32 no longer matches.
      yield* Effect.promise(() => writeFile(file, text.replace('"n":1', '"n":7')))
      const refusal = yield* Effect.flip(storage.read(header.id))
      const append = yield* Effect.flip(storage.append(header.id, Seq.make(3), turn, stored(noted, { n: 3 })))
      return { reason: refusal.reason, message: refusal.message, append: append.reason }
    })))
    expect(result.reason).toBe("Unreadable")
    expect(result.message).toEndWith(`${fileNameOf(header.id)} is not a journal's: line 3 is not the line that was written`)
    expect(result.append).toBe("Unreadable")
  })

  test("a directory of another layout, of another store, or holding other files is refused, and nothing is written in it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* scratch
      const opened = (directory: string) => Effect.flip(Layer.build(store(directory)))
      const later = join(root, "later")
      yield* Effect.promise(() => mkdir(later).then(() => writeFile(join(later, "store.json"), JSON.stringify({ store: DIRECTORY_STORE, layout: DIRECTORY_LAYOUT + 1 }))))
      const other = join(root, "other")
      yield* Effect.promise(() => mkdir(other).then(() => writeFile(join(other, "store.json"), JSON.stringify({ store: "somebody-else", layout: 1 }))))
      const home = join(root, "home")
      yield* Effect.promise(() => mkdir(home).then(() => writeFile(join(home, "notes.txt"), "mine")))
      const refusals = [yield* opened(later), yield* opened(other), yield* opened(home)]
      const left = yield* Effect.promise(() => Promise.all([later, other, home].map((directory) => readdir(directory))))
      return { refusals: refusals.map((refusal) => [refusal._tag, refusal.reason]), messages: refusals.map((refusal) => refusal.message), left }
    })))
    expect(result.refusals).toEqual([["JournalOpenFailed", "Format"], ["JournalOpenFailed", "Format"], ["JournalOpenFailed", "Format"]])
    expect(result.messages[0]).toBe(`the directory has layout ${DIRECTORY_LAYOUT + 1}; this release reads layout ${DIRECTORY_LAYOUT} only, and does not migrate`)
    expect(result.messages[1]).toEndWith('store.json names the store "somebody-else", not a journal directory')
    expect(result.messages[2]).toBe("the directory holds a file (notes.txt) and no store.json: it is not a journal directory; give an empty directory, or one that does not exist yet")
    expect(result.left).toEqual([["store.json"], ["store.json"], ["notes.txt"]])
  })

  test("a session is a file named by its id, or by the id's bytes when the id could not be a file's name; nothing is left in tmp", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const directory = join(yield* scratch, "journal")
      const storage = yield* storageAt(store, directory)
      const odd = ["../Up", "Kit", "kit", "a/b", ".", "ünï"].map((id) => SessionId.make(id))
      yield* Effect.forEach(odd, (id, at) => storage.create({ ...header, id, createdAt: at }), { concurrency: 1, discard: true })
      const files = yield* Effect.promise(() => readdir(join(directory, "sessions")))
      const tmp = yield* Effect.promise(() => readdir(join(directory, "tmp")))
      return { listed: (yield* storage.list).map((one): string => one.id), files: files.length, tmp, top: (yield* Effect.promise(() => readdir(directory))).sort() }
    })))
    expect(result).toEqual({ listed: ["../Up", "Kit", "kit", "a/b", ".", "ünï"], files: 6, tmp: [], top: ["sessions", "store.json", "tmp", "writer"] })
  })
})
