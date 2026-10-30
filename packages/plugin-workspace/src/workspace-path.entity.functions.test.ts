import { describe, expect, test } from "bun:test"
import { Effect, Option, Path, Result } from "effect"
import fc from "fast-check"
import { FileSystem, FsError, makeMemoryFileSystem, SessionEnvironment } from "@xandreed/core"
import type { FsReason } from "@xandreed/core"
import type { WorkspaceAllowedRoot } from "./workspace-path.entity.js"
import { checkWritable, compileProtect, displayOf, excludesBelow, fsFailure, isWithin, openWorkspace, resolveTarget, workspaceMissing } from "./workspace-path.entity.functions.js"

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
    expect(await resolved("/work", "dangling")).toBe("BrokenSymlink")
    expect(await resolved("/work", "/secret/key", false)).toBe("/secret/key as /secret/key")
    expect(await resolved("/work", "out-link", false)).toBe("/secret/key as out-link")
  })

  test("each refusal names the path as the model gave it and what is wrong with it", async () => {
    const refusal = (input: string) => Effect.runPromise(opened("/work").pipe(Effect.flatMap((access) => Effect.flip(resolveTarget(access, input, { confine: true })))))
    expect(await Promise.all(["../secret/key", "/secret/key", "out-link", "out-dir/new.txt", "dangling"].map(refusal))).toEqual([
      { error: "OutsideWorkspace", message: "../secret/key is outside the workspace; use a path under its root" },
      { error: "OutsideWorkspace", message: "/secret/key is outside the workspace; use a path under its root" },
      { error: "OutsideWorkspace", message: "out-link leads outside the workspace through a symbolic link" },
      { error: "OutsideWorkspace", message: "out-dir/new.txt leads outside the workspace through a symbolic link" },
      { error: "BrokenSymlink", message: "dangling: it is a symbolic link to something that does not exist" },
    ])
  })

  test("a workspace that cannot be opened is WorkspaceMissing, saying why in words, never the reason's name or the file system's message", async () => {
    const missing = await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* makeMemoryFileSystem({ "/work/a.txt": "a" })
      const path = yield* Effect.service(Path.Path).pipe(Effect.provide(Path.layer))
      return yield* Effect.flip(openWorkspace(path).pipe(Effect.provideService(FileSystem, fs), Effect.provideService(SessionEnvironment, { workspace: "/nowhere" })))
    }))
    expect(missing).toEqual({ error: "WorkspaceMissing", message: "the workspace directory does not exist, so no workspace tool can run in this session; tell the user" })
    const tail = ", so no workspace tool can run in this session; tell the user"
    const failed = (["NotFound", "NotDirectory", "Permission", "Invalid", "Exists", "IsDirectory", "NotEmpty", "Io"] as const).map(workspaceMissing)
    expect(failed).toEqual([
      { error: "WorkspaceMissing", message: `the workspace directory does not exist${tail}` },
      { error: "WorkspaceMissing", message: `the workspace directory is not a directory${tail}` },
      { error: "WorkspaceMissing", message: `the workspace directory cannot be opened for lack of permission${tail}` },
      { error: "WorkspaceMissing", message: `the workspace directory is not a path the file system accepts${tail}` },
      ...Array.from({ length: 4 }, () => ({ error: "WorkspaceMissing", message: `the workspace directory cannot be opened because of a file-system error${tail}` })),
    ])
  })
})

describe("fsFailure", () => {
  test("a file-system failure as the model reads it: every reason in words, never the backend's message", () => {
    const failed = (reason: FsReason) => fsFailure("src/a.ts")(new FsError({ path: "/work/src/a.ts", reason, message: "the backend's words" }))
    expect((["NotFound", "IsDirectory", "NotDirectory", "Permission", "Exists", "NotEmpty", "Invalid", "Io"] as const).map(failed)).toEqual([
      { error: "NotFound", message: "src/a.ts does not exist" },
      { error: "IsDirectory", message: "src/a.ts is a directory; give the path of a file" },
      { error: "NotDirectory", message: "src/a.ts is not a directory, or a part of the path before it is a file" },
      { error: "AccessDenied", message: "permission denied: src/a.ts" },
      { error: "AlreadyExists", message: "src/a.ts already exists, and the file system would not replace it; give another path" },
      { error: "DirectoryNotEmpty", message: "src/a.ts is a directory with entries in it; give another path" },
      { error: "InvalidPath", message: "src/a.ts is not a path the file system accepts; check it and try again" },
      { error: "FileSystemError", message: "src/a.ts could not be read or written (a file-system error); try again, or give another path" },
    ])
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
    expect(await Effect.runPromise(opened("/work").pipe(Effect.flatMap((access) => Effect.flip(checkWritable(access, { path: "/work/secrets/prod.env", display: "secrets/prod.env" }, rules))))))
      .toEqual({ error: "Protected", message: "secrets/prod.env is protected (secrets/*.env); the workspace tools do not change it" })
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

describe("allowed roots", () => {
  const roots = [{ path: "../secret", access: "read" as const }]
  const target = (input: string, intent: "read" | "write", options: { readonly roots?: ReadonlyArray<WorkspaceAllowedRoot>; readonly workspaceAccess?: "read" | "write"; readonly confine?: boolean } = {}) =>
    Effect.runPromise(opened("/work").pipe(
      Effect.flatMap((access) => openWorkspace(access.path, { roots: options.roots ?? roots, workspaceAccess: options.workspaceAccess ?? "write" }).pipe(
        Effect.provideService(FileSystem, access.fs), Effect.provideService(SessionEnvironment, { workspace: "/work" }),
      )),
      Effect.flatMap((access) => resolveTarget(access, input, { confine: options.confine ?? true, intent })),
      Effect.result,
    ))

  test("an extra read root permits reads and refuses writes, including paths through a workspace symlink", async () => {
    const read = await target("/secret/key", "read")
    expect(read).toEqual(Result.succeed({ path: "/secret/key", display: "/secret/key" }))
    expect(await target("out-link", "read")).toEqual(Result.succeed({ path: "/secret/key", display: "out-link" }))
    expect(await target("/secret/new/file", "write")).toEqual(Result.fail({ error: "ReadOnly", message: "/secret/new/file is under /secret, which the workspace tools may read but not change" }))
    expect(await target("out-link", "write")).toEqual(Result.fail({ error: "ReadOnly", message: "out-link is under /secret, which the workspace tools may read but not change" }))
  })

  test("the workspace may be read-only, and explicit nested roots take precedence by their longest real path", async () => {
    expect(await target("src/main.ts", "write", { workspaceAccess: "read" })).toEqual(Result.fail({ error: "ReadOnly", message: "src/main.ts is under the workspace root, which the workspace tools may read but not change" }))
    expect(await target("src/main.ts", "write", { workspaceAccess: "read", roots: [{ path: "src", access: "write" }] })).toEqual(Result.succeed({ path: "/work/src/main.ts", display: "src/main.ts" }))
    expect(await target("src/main.ts", "write", { roots: [{ path: "src", access: "read" }] })).toEqual(Result.fail({ error: "ReadOnly", message: "src/main.ts is under src, which the workspace tools may read but not change" }))
  })

  test("outside refusals name the allowed extra roots; turning confinement off leaves all file access unrestricted", async () => {
    expect(await target("/other", "read")).toEqual(Result.fail({ error: "OutsideWorkspace", message: "/other is outside the workspace and its allowed roots (/secret); use a path under one of them" }))
    expect(await target("/secret/key", "write", { confine: false })).toEqual(Result.succeed({ path: "/secret/key", display: "/secret/key" }))
  })

  test("a missing extra root is ignored, never widening access", async () => {
    expect(await target("/nowhere/file", "read", { roots: [{ path: "/nowhere", access: "write" }] })).toEqual(Result.fail({
      error: "OutsideWorkspace", message: "/nowhere/file is outside the workspace; use a path under its root",
    }))
  })

  test("extra-root boundaries hold for direct paths, symlinks and similarly named sibling directories", async () => {
    await fc.assert(fc.asyncProperty(fc.stringMatching(/^[a-z]{1,12}$/), fc.boolean(), async (name, allowed) => {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const root = `/extra/${name}`
        const fs = yield* makeMemoryFileSystem({
          "/work/main": "main", "/work/alias": { symlink: `${root}/file` },
          [`${root}/file`]: "allowed", [`${root}-other/file`]: "outside",
        })
        const path = yield* Effect.service(Path.Path).pipe(Effect.provide(Path.layer))
        const access = yield* openWorkspace(path, { workspaceAccess: "write", roots: allowed ? [{ path: root, access: "read" }] : [] }).pipe(
          Effect.provideService(FileSystem, fs), Effect.provideService(SessionEnvironment, { workspace: "/work" }),
        )
        return yield* Effect.forEach([`${root}/file`, "alias", `${root}-other/file`, "main"], (input) =>
          resolveTarget(access, input, { confine: true }).pipe(Effect.result, Effect.map(Result.isSuccess)))
      }))
      expect(result).toEqual([allowed, allowed, false, true])
    }))
  })
})

test("a link escaping every configured root is refused with its display path and the allowed roots", async () => {
  const failure = await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* makeMemoryFileSystem({ "/work/escape": { symlink: "/outside/file" }, "/outside/file": "secret", "/allowed/file": "reference" })
    const path = yield* Effect.service(Path.Path).pipe(Effect.provide(Path.layer))
    const access = yield* openWorkspace(path, { workspaceAccess: "write", roots: [{ path: "/allowed", access: "read" }] }).pipe(
      Effect.provideService(FileSystem, fs), Effect.provideService(SessionEnvironment, { workspace: "/work" }),
    )
    return yield* Effect.flip(resolveTarget(access, "escape", { confine: true }))
  }))
  expect(failure).toEqual({ error: "OutsideWorkspace", message: "escape leads outside the workspace and its allowed roots (/allowed) through a symbolic link" })
})

test("an explicit later root controls an equal-real-path tie, including aliases", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const fs = yield* makeMemoryFileSystem({ "/work/src/file": "source", "/alias": { symlink: "/work/src" } })
    const path = yield* Effect.service(Path.Path).pipe(Effect.provide(Path.layer))
    const access = yield* openWorkspace(path, { workspaceAccess: "read", roots: [
      { path: "src", access: "read" }, { path: "/alias", access: "write" },
    ] }).pipe(Effect.provideService(FileSystem, fs), Effect.provideService(SessionEnvironment, { workspace: "/work" }))
    return yield* resolveTarget(access, "src/file", { confine: true, intent: "write" })
  }))
  expect(result).toEqual({ path: "/work/src/file", display: "src/file" })
})
