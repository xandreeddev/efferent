import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import type { Context } from "effect"
import { FsError } from "../domain/file-system.entity.js"
import { FileSystem } from "../ports/file-system.port.js"
import { fileSystemConformance } from "./file-system.conformance.js"
import type { FileSystemSubject } from "./file-system.conformance.js"
import { FileSystemMemoryLive, makeMemoryFileSystem } from "./file-system.memory.adapter.js"
import type { MemoryFileSystem } from "./file-system.memory.adapter.js"
import { walkGlob } from "../domain/file-system.entity.functions.js"

type Fs = Context.Service.Shape<typeof FileSystem>

/** A fresh in-memory tree per check, with the kit's root made in it; `careless` breaks the port on purpose. */
const memorySubject = (careless: (fs: MemoryFileSystem) => Fs = (fs) => fs): FileSystemSubject => ({
  open: makeMemoryFileSystem().pipe(
    Effect.tap((fs) => fs.mkdir("/work")),
    Effect.map((fs) => ({ fs: careless(fs), root: "/work", symlink: fs.symlink })),
  ),
})

const failedChecks = (subject: FileSystemSubject) => Effect.runPromise(Effect.forEach(fileSystemConformance(subject), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : [])))).then((failed) => failed.flat().toSorted())

describe("the in-memory file system passes the FileSystem kit", () => {
  fileSystemConformance(memorySubject()).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the FileSystem kit catches careless backends", () => {
  test("a backend that lists in reverse order, refuses to remove a missing path and always follows links in stat fails those checks", async () => {
    const careless = memorySubject((fs) => ({
      ...fs,
      list: (dir) => fs.list(dir).pipe(Effect.map((entries) => entries.toReversed())),
      remove: (path, options) => fs.exists(path).pipe(Effect.flatMap((exists) => exists ? fs.remove(path, options)
        : Effect.fail(new FsError({ path, reason: "NotFound", message: "no such file" })))),
      stat: (path) => fs.stat(path),
    }))
    // The rename check reads the moved link with followSymlinks: false too.
    expect(await failedChecks(careless)).toEqual(["list", "remove", "rename", "stat"])
  })

  test("a rename that follows a link, moving its target, fails the rename check", async () => {
    const careless = memorySubject((fs) => ({ ...fs, rename: (from, to) => fs.realPath(from).pipe(Effect.flatMap((real) => fs.rename(real, to))) }))
    expect(await failedChecks(careless)).toEqual(["rename"])
  })

  test("a glob that follows links (as fs.glob does on Bun) fails the glob checks a link changes", async () => {
    // Each link reported as what it points to: a linked directory is entered, a linked file is a file.
    const careless = memorySubject((fs) => {
      const followed = (dir: string) => fs.list(dir).pipe(Effect.flatMap((entries) => Effect.forEach(entries, (entry) => entry.kind !== "symlink" ? Effect.succeed(entry)
        : fs.stat(`${dir}/${entry.name}`).pipe(Effect.map((info) => ({ name: entry.name, kind: info.kind }))))))
      return { ...fs, glob: (pattern, options) => walkGlob(followed, pattern, options) }
    })
    expect(await failedChecks(careless)).toEqual(["glob", "glob-dot", "glob-limit", "glob-recursive"])
  })

  test("a glob that lists dot entries whatever dot says fails every check with a dot entry in reach", async () => {
    const careless = memorySubject((fs) => ({ ...fs, glob: (pattern, options) => walkGlob(fs.list, pattern, { ...options, dot: true }) }))
    expect(await failedChecks(careless)).toEqual(["glob", "glob-dot", "glob-limit", "glob-only-files", "glob-recursive"])
  })
})

describe("the in-memory file system", () => {
  test("seeds files and links, and FileSystemMemoryLive starts empty", async () => {
    const seeded = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* makeMemoryFileSystem({ "/repo/src/a.ts": "a", "/repo/bin": Uint8Array.from([1, 2]), "/repo/current": { symlink: "src" } })
      return {
        text: yield* fs.read("/repo/current/a.ts"),
        bytes: [...(yield* fs.readBytes("/repo/bin"))],
        listed: (yield* fs.list("/repo")).map((entry) => `${entry.name}:${entry.kind}`),
        real: yield* fs.realPath("/repo/current/a.ts"),
      }
    }))
    expect(seeded).toEqual({ text: "a", bytes: [1, 2], listed: ["bin:file", "current:symlink", "src:directory"], real: "/repo/src/a.ts" })
    const root = await Effect.runPromise(Effect.service(FileSystem).pipe(Effect.flatMap((fs) => fs.list("/")), Effect.provide(FileSystemMemoryLive)))
    expect(root).toEqual([])
  })

  test("refuses relative paths, symlink loops, a directory moved into itself, and removing, moving or replacing the root", async () => {
    const reasons = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* makeMemoryFileSystem({ "/loop": { symlink: "/loop" }, "/dir/file": "x" })
      const reason = (effect: Effect.Effect<unknown, FsError>) => Effect.flip(effect).pipe(Effect.map((error) => error.reason), Effect.orElseSucceed(() => "succeeded"))
      return [
        yield* reason(fs.read("relative/path")),
        yield* reason(fs.read("/loop")),
        yield* reason(fs.rename("/dir", "/dir/inner")),
        yield* reason(fs.remove("/", { recursive: true })),
        yield* reason(fs.rename("/", "/moved")),
        yield* reason(fs.rename("/dir", "/")),
      ]
    }))
    expect(reasons).toEqual(["Invalid", "Invalid", "Invalid", "Invalid", "Invalid", "Invalid"])
  })

  test("never creates directories through a link whose target is missing: mkdir and createParents fail with NotFound", async () => {
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* makeMemoryFileSystem({ "/deep": { symlink: "/x/y" }, "/near": { symlink: "/z" } })
      const reason = (effect: Effect.Effect<unknown, FsError>) => Effect.flip(effect).pipe(Effect.map((error) => error.reason), Effect.orElseSucceed(() => "succeeded"))
      return {
        reasons: [
          yield* reason(fs.mkdir("/deep/b", { recursive: true })),
          yield* reason(fs.mkdir("/deep", { recursive: true })),
          yield* reason(fs.write("/deep/b/f", "t", { createParents: true })),
          yield* reason(fs.append("/deep/f", "t", { createParents: true })),
          yield* reason(fs.mkdir("/near", { recursive: true })),
          yield* reason(fs.mkdir("/near")),
        ],
        root: (yield* fs.list("/")).map((entry) => entry.name),
      }
    }))
    expect(outcome).toEqual({ reasons: ["NotFound", "NotFound", "NotFound", "NotFound", "NotFound", "Exists"], root: ["deep", "near"] })
    const seeded = await Effect.runPromise(Effect.flip(makeMemoryFileSystem({ "/l": { symlink: "/x/y" }, "/l/f": "t" })))
    expect(seeded.reason).toBe("NotFound")
  })

  test("glob refuses a pattern or an exclude whose braces stand for more than 1024 patterns, instead of matching some of them", async () => {
    const braces = Array.from({ length: 11 }, () => "{a,b}").join("")
    const refused = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* makeMemoryFileSystem({ "/work/aaaaaaaaaaa": "x" })
      return yield* Effect.forEach([fs.glob(braces, { cwd: "/work" }), fs.glob("*", { cwd: "/work", exclude: [braces] })], (globbed) => Effect.flip(globbed).pipe(
        Effect.map((error) => `${error.reason}: ${error.message}`), Effect.orElseSucceed(() => "succeeded")))
    }))
    expect(refused).toEqual(Array.from({ length: 2 }, () => "Invalid: not a usable glob pattern: its braces stand for more than 1024 patterns"))
  })

  test("keeps its own copy of written bytes and reports no mode", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* makeMemoryFileSystem()
      const bytes = Uint8Array.from([1, 2, 3])
      yield* fs.write("/f", bytes)
      bytes[0] = 9
      const read = yield* fs.readBytes("/f")
      read[1] = 9
      return { stored: [...(yield* fs.readBytes("/f"))], mode: (yield* fs.stat("/f")).mode }
    }))
    expect(result).toEqual({ stored: [1, 2, 3], mode: Option.none() })
  })
})
