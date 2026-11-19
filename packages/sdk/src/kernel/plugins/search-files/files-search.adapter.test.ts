import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { Files, filesSearch, FilesRefused, FilesUnavailable, inMemoryFiles, Search } from "../../index.js"
import type { FilePath, SearchQuery } from "../../index.js"

/** A workspace in memory whose `read` is changed by `change`, given the one it changes, and that counts the reads. */
const searchOver = (files: Readonly<Record<string, string>>, change: (inner: Files["Service"]) => Partial<Files["Service"]> = () => ({})) => Effect.gen(function* () {
  const reads = yield* Ref.make<ReadonlyArray<string>>([])
  const workspace = Layer.effect(Files, Effect.gen(function* () {
    const inner = yield* Files
    const changed = { ...inner, ...change(inner) }
    return Files.of({ ...changed, read: (path: FilePath) => Effect.andThen(Ref.update(reads, (all) => [...all, path]), changed.read(path)) })
  })).pipe(Layer.provide(inMemoryFiles(files)))
  const search = yield* Effect.provide(Search, filesSearch.pipe(Layer.provide(workspace)))
  return { find: (query: SearchQuery) => search.find(query), reads: Ref.get(reads) }
})

describe("filesSearch", () => {
  test("a file the workspace declines, or that went away since the listing, is passed over and counted", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const { find } = yield* searchOver({ "a.txt": "x", "b.bin": "x", "c.txt": "x", "d.txt": "x" }, (inner) => ({
        read: (path) => path === "b.bin"
          ? Effect.fail(new FilesRefused({ path, reason: "it is not UTF-8 text", message: "declined" }))
          : path === "c.txt" ? Effect.andThen(Effect.orDie(inner.write(path, "")), inner.read("gone.txt" as FilePath)) : inner.read(path),
      }))
      return yield* find({ pattern: "x", limit: 10 })
    }))
    expect<unknown>(out).toEqual({ matches: [{ path: "a.txt", line: 1, column: 1, text: "x" }, { path: "d.txt", line: 1, column: 1, text: "x" }], more: false, skipped: 2 })
  })

  test("it reads no file past the one that gave the match after the limit", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const { find, reads } = yield* searchOver({ "a.txt": "x\nx\n", "b.txt": "x\n", "c.txt": "x\n" })
      const found = yield* find({ pattern: "x", limit: 2 })
      return { more: found.more, reads: yield* reads }
    }))
    expect(out).toEqual({ more: true, reads: ["a.txt", "b.txt"] })
  })

  test("the medium's failure is SearchUnavailable, with its words", async () => {
    const out = await Effect.runPromise(Effect.gen(function* () {
      const { find } = yield* searchOver({ "a.txt": "x" }, () => ({ read: () => Effect.fail(new FilesUnavailable({ message: "the disk is gone" })) }))
      return yield* Effect.flip(find({ pattern: "x", limit: 2 }))
    }))
    expect(out).toMatchObject({ _tag: "SearchUnavailable", message: "the disk is gone" })
  })
})
