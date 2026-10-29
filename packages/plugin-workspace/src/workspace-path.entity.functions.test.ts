import { describe, expect, test } from "bun:test"
import { Effect, Option, Path, Result } from "effect"
import { FileSystem, makeMemoryFileSystem, SessionEnvironment } from "@xandreed/core"
import { checkWritable, compileProtect, displayOf, excludesBelow, isWithin, openWorkspace, resolveTarget } from "./workspace-path.entity.functions.js"

/** A workspace at /work in memory, reached through a link at /link, with a secret beside it and links in and out. */
const opened = (workspace: string) => Effect.gen(function* () {
  const fs = yield* makeMemoryFileSystem({
    "/work/src/main.ts": "main",
    "/work/in-link": { symlink: "src/main.ts" },
    "/work/out-link": { symlink: "/secret/key" },
    "/work/out-dir": { symlink: "/secret" },
    "/work/dangling": { symlink: "/nowhere/file" },
    "/secret/key": "key",
    "/link": { symlink: "/work" },
  })
  const path = yield* Effect.service(Path.Path).pipe(Effect.provide(Path.layer))
  return yield* openWorkspace(path).pipe(Effect.provideService(FileSystem, fs), Effect.provideService(SessionEnvironment, { workspace }))
}).pipe(Effect.orDie)

const resolved = (workspace: string, input: string, confine = true) => Effect.runPromise(opened(workspace).pipe(
  Effect.flatMap((access) => resolveTarget(access, input, { confine })),
  Effect.match({ onFailure: (failure) => failure.error, onSuccess: (target) => `${target.path} as ${target.display}` }),
))

describe("resolveTarget", () => {
  test("relative and absolute paths inside the workspace resolve to their real place", async () => {
    expect(await resolved("/work", "src/main.ts")).toBe("/work/src/main.ts as src/main.ts")
    expect(await resolved("/work", "/work/src/./lib/../main.ts")).toBe("/work/src/main.ts as src/main.ts")
    expect(await resolved("/work", "in-link")).toBe("/work/src/main.ts as in-link")
    expect(await resolved("/work", "")).toBe("/work as .")
    // Not there yet: the nearest existing ancestor is resolved and the rest kept.
    expect(await resolved("/work", "src/new/file.ts")).toBe("/work/src/new/file.ts as src/new/file.ts")
  })

  test("a workspace given through a link resolves paths against its real place, and accepts both spellings", async () => {
    expect(await resolved("/link", "src/main.ts")).toBe("/work/src/main.ts as src/main.ts")
    expect(await resolved("/link", "/link/src/main.ts")).toBe("/work/src/main.ts as src/main.ts")
  })

  test("escapes by .., by an absolute path and through links are refused; a dangling link is never written through", async () => {
    expect(await Promise.all(["../secret/key", "/secret/key", "out-link", "out-dir/key", "out-dir/new.txt", "src/../../secret/key"].map((input) => resolved("/work", input))))
      .toEqual(Array.from({ length: 6 }, () => "OutsideWorkspace"))
    expect(await resolved("/work", "dangling")).toBe("Invalid")
    expect(await resolved("/work", "/secret/key", false)).toBe("/secret/key as /secret/key")
    expect(await resolved("/work", "out-link", false)).toBe("/secret/key as out-link")
  })
})

describe("protect and display", () => {
  test("protected globs refuse writes by the path as written and by its real place", async () => {
    const rules = Result.getOrThrow(compileProtect([".git/**", "secrets/*.env"]))
    const outcome = (path: string, display: string) => Effect.runPromise(opened("/work").pipe(
      Effect.flatMap((access) => checkWritable(access, { path, display }, rules)),
      Effect.match({ onFailure: (failure) => failure.error, onSuccess: () => "ok" }),
    ))
    expect(await outcome("/work/.git/config", ".git/config")).toBe("Protected")
    expect(await outcome("/work/.git/config", "alias-of-git-config")).toBe("Protected")
    expect(await outcome("/work/secrets/prod.env", "secrets/prod.env")).toBe("Protected")
    expect(await outcome("/work/src/main.ts", "src/main.ts")).toBe("ok")
    expect(Result.isFailure(compileProtect(["{a,b}".repeat(11)]))).toBe(true)
  })

  test("paths show relative to the root, absolute outside it", async () => {
    const access = await Effect.runPromise(opened("/work"))
    expect([displayOf(access, "/work"), displayOf(access, "/work/a/b"), displayOf(access, "/elsewhere")]).toEqual([".", "a/b", "/elsewhere"])
    expect([isWithin("/work", "/work"), isWithin("/work", "/workshop"), isWithin("/", "/any")]).toEqual([true, false, true])
  })
})

describe("excludesBelow", () => {
  const excludes = ["node_modules", "src/gen", "**/dist", "lib/*", "*/cache", "src/**/tmp"]

  test("from the root, every glob is as configured", () => {
    expect(excludesBelow(excludes, Option.some(""))).toEqual(excludes)
  })

  test("from a directory, path globs are made relative to it, and dropped when they cannot reach below it", () => {
    expect(excludesBelow(excludes, Option.some("src"))).toEqual(["node_modules", "./gen", "./**/dist", "./cache", "./**/tmp"])
    expect(excludesBelow(excludes, Option.some("src/app"))).toEqual(["node_modules", "./**/dist", "./**/tmp"])
    expect(excludesBelow(excludes, Option.some("lib"))).toEqual(["node_modules", "./**/dist", "./*", "./cache"])
  })

  test("a path glob naming the directory itself, or one above it, is dropped: the walk was asked to go there", () => {
    expect(excludesBelow(["src/gen", "**/gen"], Option.some("src/gen"))).toEqual(["./**/gen"])
    expect(excludesBelow(["src"], Option.some("src/gen"))).toEqual(["src"])
    expect(excludesBelow(["src/*"], Option.some("src/gen/deep"))).toEqual([])
  })

  test("outside the workspace only names apply; braces spanning segments are kept as they are", () => {
    expect(excludesBelow(excludes, Option.none())).toEqual(["node_modules"])
    expect(excludesBelow(["{src/gen,lib/gen}"], Option.some("src"))).toEqual(["{src/gen,lib/gen}"])
    expect(excludesBelow(["src/{gen,out}"], Option.some("src"))).toEqual(["./{gen,out}"])
  })
})
