import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { JOURNAL_FORMAT, journalStorageConformance, Owner, Seq, SessionId, sessionsConformance, stored, storedEvent, TurnNumber } from "@xandreed/core/kernel"
import { failedChecks, killed, scratch, sessionsSubject, storageAt, storageSubject } from "../testing.js"
import { sqliteJournal } from "./sqlite-journal.adapter.js"
import { SQLITE_APPLICATION_ID, SQLITE_SCHEMA } from "./sqlite-journal.entity.js"

/*
 * The SQLite journal on Bun (the packed packages run it on Node too, over
 * `node:sqlite`): the kernel's kits over it, a database another process left
 * in the middle of a transaction, and the databases it refuses.
 */

const store = (path: string) => sqliteJournal({ path })
const header = { id: SessionId.make("s-1"), owner: Owner.make("learner"), createdAt: 1, format: JOURNAL_FORMAT }
const noted = storedEvent("kit", "noted", { data: Schema.Json, skippable: true, tags: ["kit.noted"] })
const turn = TurnNumber.make(1)

describe("the SQLite journal", () => {
  test("passes the storage kit, a second handle of the process on the same database included", async () => {
    const checks = journalStorageConformance(storageSubject(store, "journal.db"))
    expect(checks.map((check) => check.id)).toContain("reopens")
    expect(await failedChecks(checks)).toEqual([])
  })

  test("passes the sessions kit under the stock session plugin", async () => {
    expect(await failedChecks(sessionsConformance(sessionsSubject(store, "journal.db")))).toEqual([])
  })

  test("a process killed in the middle of an append's transaction left the database as it was before it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const path = join(yield* scratch, "journal.db")
      yield* Effect.scoped(Effect.gen(function* () {
        const first = yield* storageAt(store, path)
        yield* first.create(header)
        yield* first.append(header.id, Seq.make(0), turn, stored(noted, { n: 1 }))
      }))
      // A writer that inserted its event and was killed before its commit.
      const child = Bun.spawn([process.execPath, "-e", `
        import { Database } from "bun:sqlite"
        const db = new Database(${JSON.stringify(path)})
        db.exec("BEGIN IMMEDIATE")
        db.query("INSERT INTO events (session, seq, event) VALUES ('s-1', 2, '{}')").run()
        console.log("inside")
        setInterval(() => {}, 1000)
      `], { stdout: "pipe", stderr: "inherit" })
      const said = yield* Effect.promise(() => child.stdout.getReader().read().then(({ value }) => new TextDecoder().decode(value)))
      yield* killed(child)
      const storage = yield* storageAt(store, path)
      const read = yield* storage.read(header.id)
      const appended = yield* storage.append(header.id, Seq.make(1), turn, stored(noted, { n: 2 }))
      return { said: said.trim(), before: read.events.map((event) => event.data), appended: Number(appended.seq) }
    })))
    expect(result).toEqual({ said: "inside", before: [{ n: 1 }], appended: 2 })
  }, 30_000)

  test("a database of another schema, another application's, and a file that is no database are refused, and left as they were", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* scratch
      const later = join(root, "later.db")
      const other = join(root, "other.db")
      const text = join(root, "notes.db")
      yield* Effect.sync(() => {
        const db = new Database(later, { create: true })
        db.exec(`CREATE TABLE sessions (id TEXT); PRAGMA application_id = ${SQLITE_APPLICATION_ID}; PRAGMA user_version = ${SQLITE_SCHEMA + 1};`)
        db.close()
        const theirs = new Database(other, { create: true })
        theirs.exec("CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('mine');")
        theirs.close()
      })
      yield* Effect.promise(() => writeFile(text, "these are my notes, not a database, and long enough to have a header's worth of bytes in them.".repeat(4)))
      const refusals = yield* Effect.forEach([later, other, text], (path) => Effect.flip(Layer.build(store(path))), { concurrency: 1 })
      const notes = yield* Effect.sync(() => {
        const theirs = new Database(other)
        const rows = theirs.query("SELECT text FROM notes").all()
        theirs.close()
        return rows
      })
      return { refusals: refusals.map((refusal) => [refusal.reason, refusal.message]), notes }
    })))
    expect(result.refusals[0]).toEqual(["Format", expect.stringMatching(new RegExp(`later\\.db is at schema ${SQLITE_SCHEMA + 1}; this release reads schema ${SQLITE_SCHEMA} only, and does not migrate$`))])
    expect(result.refusals[1]).toEqual(["Format", expect.stringMatching(/other\.db is another application's database \(application id 0\), not a journal database$/)])
    expect(result.refusals[2]?.[0]).toBe("Format")
    expect(result.refusals[2]?.[1]).toMatch(/notes\.db is not a SQLite database: /)
    expect(result.notes).toEqual([{ text: "mine" }])
  })
})
