import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Option, Result } from "effect"
import { Files, filesConformance, filesSearch, Search, searchConformance, workspacePath } from "../../index.js"
import type { FilePath } from "../../index.js"
import { scratch } from "../testing.js"
import { diskFiles } from "./disk-files.adapter.js"
import { DEFAULT_IGNORE } from "./disk-files.entity.js"
import type { DiskFilesOptions } from "./disk-files.entity.js"

/*
 * A workspace in a folder of the disk: the files kit, the search kit over it,
 * and the cases the kit in memory never meets, each decided in ADR 0028: a
 * path through a link, a file that is not UTF-8 or is too large, a name that
 * is no path, a loop of links, what a listing passes over, a write's
 * temporary file.
 */

const at = (text: string): FilePath => Result.getOrThrowWith(workspacePath(text), (problem) => new Error(problem))

/** The workspace over a folder, built in the scope. */
const filesIn = (root: string, options: Omit<DiskFilesOptions, "root"> = {}) =>
  Effect.map(Effect.orDie(Layer.build(diskFiles({ root, ...options }))), (services) => Context.get(services, Files))

/** A fresh, empty folder of the scratch folder, for one check. */
let made = 0
const fresh = Effect.flatMap(scratch, (folder) => Effect.promise(async () => {
  const path = join(folder, `w${++made}`)
  await mkdir(path)
  return path
}))

const failureOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.flip(effect), (error) => ({ tag: error._tag, ...("reason" in error ? { reason: error.reason } : {}) }))

describe("diskFiles", () => {
  for (const check of filesConformance({ open: Effect.flatMap(fresh, (root) => filesIn(root)) })) {
    test(`passes the files kit's ${check.id} check`, async () => {
      expect(await Effect.runPromise(Effect.result(check.run))).toMatchObject({ _tag: "Success" })
    })
  }

  for (const check of searchConformance({
    open: (files) => Effect.gen(function* () {
      const root = yield* fresh
      for (const [path, text] of Object.entries(files)) {
        yield* Effect.promise(async () => {
          await mkdir(join(root, path, ".."), { recursive: true })
          await writeFile(join(root, path), text)
        })
      }
      return yield* Effect.map(Effect.orDie(Layer.build(filesSearch.pipe(Layer.provide(diskFiles({ root }))))), (services) => Context.get(services, Search))
    }),
  })) {
    test(`the search over it passes the search kit's ${check.id} check`, async () => {
      expect(await Effect.runPromise(Effect.result(check.run))).toMatchObject({ _tag: "Success" })
    })
  }

  test("a path through a link that leads outside the root is declined, read and written; a link inside is followed", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const outsider = yield* fresh
      const root = yield* fresh
      yield* Effect.promise(async () => {
        await writeFile(join(outsider, "secret.txt"), "kept out")
        await writeFile(join(root, "real.txt"), "inside")
        await symlink(join(outsider, "secret.txt"), join(root, "secret.txt"))
        await symlink(outsider, join(root, "away"))
        await symlink(join(root, "real.txt"), join(root, "alias.txt"))
      })
      const files = yield* filesIn(root)
      return {
        readFile: yield* failureOf(files.read(at("secret.txt"))),
        readFolder: yield* failureOf(files.read(at("away/secret.txt"))),
        writeFile: yield* failureOf(files.write(at("secret.txt"), "x")),
        writeNew: yield* failureOf(files.write(at("away/new.txt"), "x")),
        writeDeeper: yield* failureOf(files.write(at("away/deeper/new.txt"), "x")),
        alias: yield* files.read(at("alias.txt")),
        listed: yield* files.list(Option.none()),
        outsider: yield* Effect.promise(() => readdir(outsider)),
        secret: yield* Effect.promise(() => readFile(join(outsider, "secret.txt"), "utf8")),
      }
    })))
    const declined = { tag: "FilesRefused", reason: "it leads outside the workspace" }
    expect<unknown>(out).toEqual({
      readFile: declined, readFolder: declined, writeFile: declined, writeNew: declined, writeDeeper: declined,
      alias: "inside",
      listed: ["alias.txt", "real.txt"],
      outsider: ["secret.txt"],
      secret: "kept out",
    })
  })

  test("a file that is not UTF-8 is declined in words, never read with replacement characters; a byte-order mark is kept", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(async () => {
        await writeFile(join(root, "image.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))
        await writeFile(join(root, "bom.txt"), new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))
      })
      const files = yield* filesIn(root)
      const bom = yield* files.read(at("bom.txt"))
      yield* files.write(at("bom.txt"), `${bom}!`, { _tag: "Holds", text: bom })
      return {
        binary: yield* failureOf(files.read(at("image.png"))),
        // A write that expects text of a file that is no text: the file does not hold it.
        overBinary: yield* failureOf(files.write(at("image.png"), "x", { _tag: "Holds", text: "" })),
        bom: [...bom].map((char) => char.codePointAt(0)),
        written: Array.from(yield* Effect.promise(() => readFile(join(root, "bom.txt")))),
      }
    })))
    expect(out).toEqual({
      binary: { tag: "FilesRefused", reason: "it is not UTF-8 text" },
      overBinary: { tag: "FileChanged" },
      bom: [0xfeff, 0x68, 0x69],
      written: [0xef, 0xbb, 0xbf, 0x68, 0x69, 0x21],
    })
  })

  test("a file over the bound is declined, read and written, and a search passes over it and counts it", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(async () => {
        await writeFile(join(root, "big.txt"), "x".repeat(101))
        await writeFile(join(root, "small.txt"), "x")
      })
      const files = yield* filesIn(root, { maxBytes: 100 })
      const search = Context.get(yield* Layer.build(filesSearch.pipe(Layer.provide(diskFiles({ root, maxBytes: 100 })))), Search)
      return {
        read: yield* failureOf(files.read(at("big.txt"))),
        write: yield* failureOf(files.write(at("other.txt"), "é".repeat(51))),
        found: yield* search.find({ pattern: "x", limit: 10 }),
      }
    })))
    expect<unknown>(out).toEqual({
      read: { tag: "FilesRefused", reason: "it is 101 bytes, more than the 100 this workspace takes" },
      write: { tag: "FilesRefused", reason: "it is 102 bytes, more than the 100 this workspace takes" },
      found: { matches: [{ path: "small.txt", line: 1, column: 1, text: "x" }], more: false, skipped: 1 },
    })
  })

  test("a listing passes over a name that is no path, a loop of links, a link to nothing, a link to a folder, the ignored names and a write's temporary file", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(async () => {
        await writeFile(join(root, "a:b.txt"), "x")
        await writeFile(join(root, "tab\there.txt"), "x")
        await symlink(join(root, "loop-b"), join(root, "loop-a"))
        await symlink(join(root, "loop-a"), join(root, "loop-b"))
        await symlink(join(root, "missing.txt"), join(root, "dangling.txt"))
        await mkdir(join(root, "notes"))
        await writeFile(join(root, "notes", "n.md"), "x")
        await symlink(join(root, "notes"), join(root, "notes-again"))
        await symlink(root, join(root, "notes", "up"))
        for (const ignored of [".git", "node_modules", "dist"]) {
          await mkdir(join(root, ignored))
          await writeFile(join(root, ignored, "kept.txt"), "x")
        }
        await writeFile(join(root, ".efferent-0b6f3c2e-6f2b-4f53-9d7e-7f0c4a8f1e2d.tmp"), "left by a crash")
        await writeFile(join(root, "kept.txt"), "x")
      })
      const files = yield* filesIn(root)
      const custom = yield* filesIn(root, { ignore: [...DEFAULT_IGNORE, "dist"] })
      return {
        listed: yield* files.list(Option.none()),
        custom: yield* custom.list(Option.none()),
        loop: yield* failureOf(files.read(at("loop-a"))),
        dangling: yield* failureOf(files.read(at("dangling.txt"))),
        writeDangling: yield* failureOf(files.write(at("dangling.txt"), "x")),
        // A path under an ignored name is not listed, and is still a path of the workspace.
        ignoredRead: yield* files.read(at(".git/kept.txt")),
        notesAgain: yield* files.read(at("notes-again/n.md")),
      }
    })))
    expect<unknown>(out).toEqual({
      listed: ["dist/kept.txt", "kept.txt", "notes/n.md"],
      custom: ["kept.txt", "notes/n.md"],
      loop: { tag: "FilesRefused", reason: "it is a link that leads back to itself" },
      dangling: { tag: "FileNotFound" },
      writeDangling: { tag: "FilesRefused", reason: "it is a link that leads to nothing" },
      ignoredRead: "x",
      notesAgain: "x",
    })
  })

  test("a write is whole: it goes through a temporary file, leaves none, keeps the file's mode and makes the folders a new file needs", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(async () => {
        await writeFile(join(root, "run.sh"), "echo one\n")
        await chmod(join(root, "run.sh"), 0o750)
      })
      const files = yield* filesIn(root)
      yield* files.write(at("run.sh"), "echo two\n", { _tag: "Holds", text: "echo one\n" })
      yield* files.write(at("deep/er/new.txt"), "new")
      return {
        names: yield* Effect.promise(() => readdir(root)),
        mode: ((yield* Effect.promise(() => stat(join(root, "run.sh")))).mode & 0o777).toString(8),
        text: yield* files.read(at("run.sh")),
        deep: yield* files.read(at("deep/er/new.txt")),
        aFolder: yield* failureOf(files.write(at("deep"), "x")),
        aFileAsFolder: yield* failureOf(files.write(at("run.sh/inside.txt"), "x")),
        missing: yield* failureOf(files.read(at("deep/none.txt"))),
        folderRead: yield* failureOf(files.read(at("deep"))),
      }
    })))
    expect({ ...out, names: out.names.toSorted() }).toEqual({
      names: ["deep", "run.sh"],
      mode: "750",
      text: "echo two\n",
      deep: "new",
      aFolder: { tag: "FilesRefused", reason: "a folder is at that path" },
      aFileAsFolder: { tag: "FilesRefused", reason: "a file is where a folder must be (run.sh)" },
      missing: { tag: "FileNotFound" },
      folderRead: { tag: "FileNotFound" },
    })
  })

  test.skipIf(process.getuid?.() === 0)("a file the system does not let the workspace read or write is declined in words", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(async () => {
        await writeFile(join(root, "locked.txt"), "x")
        await chmod(join(root, "locked.txt"), 0o000)
      })
      const files = yield* filesIn(root)
      const result = {
        read: yield* failureOf(files.read(at("locked.txt"))),
        write: yield* failureOf(files.write(at("locked.txt"), "y", { _tag: "Holds", text: "x" })),
      }
      yield* Effect.promise(() => chmod(join(root, "locked.txt"), 0o600))
      return result
    })))
    expect(out).toEqual({
      read: { tag: "FilesRefused", reason: "the system does not let it be read" },
      write: { tag: "FileChanged" },
    })
  })

  test("two writes that expect the same text, made at once by two layers of one process over one root: one writes, one fails FileChanged", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(() => writeFile(join(root, "a.txt"), "zero"))
      const [one, two] = [yield* filesIn(root), yield* filesIn(root)]
      const results = yield* Effect.all([
        Effect.result(one.write(at("a.txt"), "one", { _tag: "Holds", text: "zero" })),
        Effect.result(two.write(at("a.txt"), "two", { _tag: "Holds", text: "zero" })),
      ], { concurrency: "unbounded" })
      return { outcomes: results.map((result) => result._tag === "Success" ? "written" : result.failure._tag).toSorted(), text: yield* one.read(at("a.txt")) }
    })))
    expect(out.outcomes).toEqual(["FileChanged", "written"])
    expect(["one", "two"]).toContain(out.text)
  })

  test("a root that is not a folder fails the layer with FilesUnavailable; options that are none die where it is built", async () => {
    const out = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const root = yield* fresh
      yield* Effect.promise(() => writeFile(join(root, "file"), "x"))
      return {
        missing: (yield* Effect.flip(Layer.build(diskFiles({ root: join(root, "none") }))))._tag,
        file: (yield* Effect.flip(Layer.build(diskFiles({ root: join(root, "file") })))).message.endsWith("is not a folder"),
        bound: String(yield* Effect.flip(Effect.sandbox(Layer.build(diskFiles({ root, maxBytes: 0 }))))),
        ignore: String(yield* Effect.flip(Effect.sandbox(Layer.build(diskFiles({ root, ignore: ["a/b"] }))))),
      }
    })))
    expect(out.missing).toBe("FilesUnavailable")
    expect(out.file).toBe(true)
    expect(out.bound).toContain("diskFiles: maxBytes must be a whole number of at least 1")
    expect(out.ignore).toContain("diskFiles: ignore holds names, not paths")
  })
})
