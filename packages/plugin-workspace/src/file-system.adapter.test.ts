import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { FileSystem } from "@xandreed/core"
import { fileSystemConformance } from "@xandreed/core/conformance"
import type { FsError } from "@xandreed/core"
import type { FileSystemSubject } from "@xandreed/core/conformance"
import { FileSystemLive, localFileSystem } from "./file-system.adapter.js"

/** A fresh directory under the system's temporary directory, removed with its scope. */
const temporary = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-fs-"))),
  (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
)

const subject: FileSystemSubject = {
  open: temporary.pipe(Effect.map((root) => ({ fs: localFileSystem, root, symlink: (target: string, path: string) => Effect.tryPromise(() => symlink(target, path)) }))),
}

const reasonOf = (effect: Effect.Effect<unknown, FsError>) => Effect.flip(effect).pipe(Effect.map((error) => error.reason), Effect.orElseSucceed(() => "succeeded"))
const inTemporary = <A>(body: (root: string) => Effect.Effect<A, unknown>) => Effect.runPromise(Effect.scoped(temporary.pipe(Effect.flatMap(body))))

describe("the local file system passes the FileSystem kit", () => {
  fileSystemConformance(subject).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))
})

describe("the local file system", () => {
  test("FileSystemLive provides it", async () => {
    const provided = await Effect.runPromise(Effect.service(FileSystem).pipe(Effect.provide(FileSystemLive)))
    expect(provided).toBe(localFileSystem)
  })

  test("refuses relative paths before touching the disk, and never removes the root or a path ending in . or ..", async () => {
    const reasons = await Effect.runPromise(Effect.all([
      reasonOf(localFileSystem.read("relative.txt")),
      reasonOf(localFileSystem.write("relative.txt", "x")),
      reasonOf(localFileSystem.rename("/tmp/efferent-never-there", "relative")),
      reasonOf(localFileSystem.remove("relative")),
      // Never recursive here: without the guard, rmdir of the root fails anyway (it is never empty).
      reasonOf(localFileSystem.remove("/")),
      reasonOf(localFileSystem.remove("//")),
      reasonOf(localFileSystem.remove("/tmp/..")),
      reasonOf(localFileSystem.remove("/tmp/.")),
    ]))
    expect([...reasons]).toEqual(Array.from({ length: 8 }, () => "Invalid"))
  })

  test.skipIf(!existsSync("/proc/self/cmdline"))("a range of a file that reports a size of 0 (a /proc entry) reads what is there, as the whole file does", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const whole = yield* localFileSystem.readBytes("/proc/self/cmdline")
      const head = yield* localFileSystem.readBytes("/proc/self/cmdline", { length: 4 })
      const rest = yield* localFileSystem.readBytes("/proc/self/cmdline", { offset: 2 })
      const size = (yield* localFileSystem.stat("/proc/self/cmdline")).size
      return { size, nonEmpty: whole.length > 4, head: [...head], rest: [...rest], expected: { head: [...whole.subarray(0, 4)], rest: [...whole.subarray(2)] } }
    }))
    expect(result.size).toBe(0)
    expect(result.nonEmpty).toBe(true)
    expect({ head: result.head, rest: result.rest }).toEqual(result.expected)
  })

  test("readBytes reads a range of a large file through a handle, and stat reports the permission bits", async () => {
    const result = await inTemporary((root) => Effect.gen(function* () {
      const bytes = Uint8Array.from({ length: 300_000 }, (_, index) => index % 251)
      yield* localFileSystem.write(join(root, "big.bin"), bytes)
      const middle = yield* localFileSystem.readBytes(join(root, "big.bin"), { offset: 200_000, length: 5 })
      const tail = yield* localFileSystem.readBytes(join(root, "big.bin"), { offset: 299_998 })
      yield* Effect.promise(() => chmod(join(root, "big.bin"), 0o640))
      const info = yield* localFileSystem.stat(join(root, "big.bin"))
      return { middle: [...middle], tail: [...tail], plain: middle.constructor.name, size: info.size, mode: Option.getOrNull(info.mode) }
    }))
    expect(result).toEqual({ middle: [200_000 % 251, 200_001 % 251, 200_002 % 251, 200_003 % 251, 200_004 % 251], tail: [299_998 % 251, 299_999 % 251], plain: "Uint8Array", size: 300_000, mode: 0o640 })
  })

  test("a directory it may not read fails with Permission, and glob skips one below its cwd", async () => {
    const result = await inTemporary((root) => Effect.gen(function* () {
      yield* localFileSystem.write(join(root, "open/a.txt"), "a", { createParents: true })
      yield* localFileSystem.write(join(root, "closed/b.txt"), "b", { createParents: true })
      yield* Effect.promise(() => chmod(join(root, "closed"), 0o000))
      const listed = yield* reasonOf(localFileSystem.list(join(root, "closed")))
      const globbed = yield* localFileSystem.glob("**/*.txt", { cwd: root })
      yield* Effect.promise(() => chmod(join(root, "closed"), 0o700))
      return { listed, globbed: globbed.paths }
    }))
    // A superuser reads any directory: then the listing succeeds and glob finds both files.
    const superuser = process.getuid?.() === 0
    expect(result).toEqual(superuser
      ? { listed: "succeeded", globbed: ["closed/b.txt", "open/a.txt"] }
      : { listed: "Permission", globbed: ["open/a.txt"] })
  })

  test("a symbolic link loop is Invalid, and exists through a file is false", async () => {
    const result = await inTemporary((root) => Effect.gen(function* () {
      yield* Effect.promise(() => symlink(join(root, "loop"), join(root, "loop")))
      yield* localFileSystem.write(join(root, "file"), "x")
      return [yield* reasonOf(localFileSystem.read(join(root, "loop"))), yield* localFileSystem.exists(join(root, "file/below"))]
    }))
    expect(result).toEqual(["Invalid", false])
  })
})
