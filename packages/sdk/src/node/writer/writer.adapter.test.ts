import { describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { directoryJournal } from "../journal-directory/directory-journal.adapter.js"
import { sqliteJournal } from "../journal-sqlite/sqlite-journal.adapter.js"
import { holder, killed, scratch } from "../testing.js"
import { holdWriter } from "./writer.adapter.js"

/*
 * One writer per store: a store's layer takes it as it is built, a second
 * process is refused while the first lives, the store is taken over once its
 * holder's process is gone, and it is let go when the layer closes. Each
 * store is checked over real processes, killed as a crash kills them.
 */

const stores = [
  { kind: "directory", at: (root: string) => join(root, "journal"), writer: (root: string) => join(root, "journal", "writer"), layer: (path: string) => directoryJournal({ directory: path }) },
  { kind: "sqlite", at: (root: string) => join(root, "journal.db"), writer: (root: string) => join(root, "journal.db.writer"), layer: (path: string) => sqliteJournal({ path }) },
] as const

const holderFiles = (folder: string) => Effect.promise(() => readdir(folder).then((names) => names.filter((name) => /^\d+\.json$/.test(name)).sort()))

for (const { kind, at, writer, layer } of stores) describe(`the ${kind} journal's writer`, () => {
  test("a second process is refused while the first holds the store; once the first is killed, the store is taken over", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* scratch
      const { child, line } = yield* holder(kind, at(root), "hold")
      const refused = yield* Effect.flip(Effect.scoped(Layer.build(layer(at(root)))))
      yield* killed(child)
      const after = yield* Effect.scoped(Effect.gen(function* () {
        yield* Layer.build(layer(at(root)))
        const files = yield* holderFiles(writer(root))
        const held = JSON.parse(yield* Effect.promise(() => readFile(join(writer(root), files[0] ?? ""), "utf8")))
        return { files, pid: held.pid === process.pid }
      }))
      return { line, refused: [refused.reason, refused.message], after, left: yield* holderFiles(writer(root)), root }
    })))
    expect(result.line).toBe('{"held":true}')
    expect(result.refused[0]).toBe("Held")
    expect(result.refused[1]).toMatch(/^the store is held by process \d+ on .+, since \d{4}-\d\d-\d\dT[^,]+, which is running; if it is not the store's writer, stop it, or remove (.+) once it is gone$/)
    expect(result.refused[1]).toEndWith(`remove ${join(writer(result.root), "1.json")} once it is gone`)
    expect(result.after).toEqual({ files: ["2.json"], pid: true })
    expect(result.left).toEqual([])
  }, 30_000)

  test("a process that opens a store this one holds is refused", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* scratch
      yield* Layer.build(layer(at(root)))
      const { line } = yield* holder(kind, at(root), "hold")
      return JSON.parse(line)
    })))
    expect(result.refused).toBe("Held")
    expect(result.message).toContain("which is running")
  }, 30_000)
})

describe("the writer lock in one process", () => {
  test("two handles of the process share the store and its lane; the holder file goes when the last one closes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const folder = join(yield* scratch, "writer")
      return yield* Effect.scoped(Effect.gen(function* () {
        const first = yield* holdWriter(folder, "store")
        const files = yield* Effect.scoped(Effect.gen(function* () {
          const second = yield* holdWriter(folder, "store")
          return { shared: second.lane === first.lane, first: [first.first, second.first], files: yield* holderFiles(folder) }
        }))
        return { ...files, afterSecond: yield* holderFiles(folder) }
      })).pipe(Effect.flatMap((during) => Effect.map(holderFiles(folder), (afterBoth) => ({ ...during, afterBoth }))))
    })))
    expect(result).toEqual({ shared: true, first: [true, false], files: ["1.json"], afterSecond: ["1.json"], afterBoth: [] })
  })

  test("a holder file of another machine is never taken over; one naming this process's id, which no handle holds, was a process before this one's", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* scratch
      const elsewhere = join(root, "elsewhere")
      const before = join(root, "before")
      yield* Effect.promise(() => Promise.all([
        mkdir(elsewhere).then(() => writeFile(join(elsewhere, "4.json"), JSON.stringify({ pid: process.pid, host: `not-${hostname()}`, token: "t", since: 0 }))),
        mkdir(before).then(() => writeFile(join(before, "4.json"), JSON.stringify({ pid: process.pid, host: hostname(), token: "t", since: 0 }))),
      ]))
      const refused = yield* Effect.flip(Effect.scoped(holdWriter(elsewhere, "elsewhere")))
      const taken = yield* Effect.scoped(Effect.andThen(holdWriter(before, "before"), holderFiles(before)))
      const unreadable = join(root, "unreadable")
      yield* Effect.promise(() => mkdir(unreadable).then(() => writeFile(join(unreadable, "1.json"), "{")))
      const damaged = yield* Effect.flip(Effect.scoped(holdWriter(unreadable, "unreadable")))
      return { refused: [refused.reason, refused.message.includes("another machine")], taken, damaged: [damaged.reason, damaged.message] }
    })))
    expect(result.refused).toEqual(["Held", true])
    expect(result.taken).toEqual(["5.json"])
    expect(result.damaged[0]).toBe("Held")
    expect(result.damaged[1]).toEndWith("unreadable/1.json does not name a holder; if no process holds the store, remove it")
  })
})
