import { Effect } from "effect"
import type { Context, Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, fail } from "../conformance.functions.js"
import type { DirEntry, FsError, FsReason, GlobOptions, GlobResult } from "../domain/file-system.entity.js"
import type { FileSystem } from "../ports/file-system.port.js"

type Fs = Context.Service.Shape<typeof FileSystem>

/**
 * One check's file system: the port, an empty directory to work in, and a way
 * to make links.
 *
 * @public
 */
export interface FileSystemFixture {
  readonly fs: Fs
  /** An absolute directory that exists and is empty; the check works only below it. */
  readonly root: string
  /** Make a symbolic link at `path` to `target`, as `ln -s target path` does (the port has no call for it). */
  readonly symlink: (target: string, path: string) => Effect.Effect<void, unknown>
}

/**
 * A FileSystem backend as the kit opens it: each run of `open` gives one
 * check its fixture, a fresh empty `root` released (and removed) with its
 * scope: a temporary directory on disk, a new tree in memory.
 */
export interface FileSystemSubject {
  readonly open: Effect.Effect<FileSystemFixture, unknown, Scope.Scope>
}

const show = (value: unknown): string => JSON.stringify(value)
const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const entries = (listed: ReadonlyArray<DirEntry>): string => listed.map((entry) => `${entry.name}:${entry.kind}`).join("|")
const under = (root: string, relative: string): string => root.endsWith("/") ? `${root}${relative}` : `${root}/${relative}`

/** `effect` fails with an `FsError` for `reason` (naming `path`, when given). */
const refuses = (id: string, what: string, effect: Effect.Effect<unknown, FsError>, reason: FsReason, path?: string) =>
  Effect.result(effect).pipe(Effect.flatMap((result) => {
    if (result._tag === "Success") return fail(id, `${what} succeeded; it must fail with ${reason}`)
    const error = result.failure
    return expect(id, error._tag === "FsError" && error.reason === reason && (path === undefined || error.path === path),
      `${what} failed with ${show({ tag: error._tag, reason: error.reason, path: error.path })}, not ${reason}${path === undefined ? "" : ` for ${path}`}`)
  }))

/**
 * The tree the glob checks walk:
 *
 *     .hidden/h.ts   docs/x.md   file1.txt  file2.txt  file10.txt
 *     link.ts -> top.ts          linked -> src (a directory)
 *     node_modules/m/i.ts        top.ts
 *     src/.dot.ts  src/a.ts  src/b.ts  src/c.js  src/deep/d.ts  src/deep/deeper/e.ts
 */
const globTree = ({ fs, root, symlink }: FileSystemFixture) => Effect.gen(function* () {
  const files = [".hidden/h.ts", "docs/x.md", "file1.txt", "file2.txt", "file10.txt", "node_modules/m/i.ts", "top.ts",
    "src/.dot.ts", "src/a.ts", "src/b.ts", "src/c.js", "src/deep/d.ts", "src/deep/deeper/e.ts"]
  yield* Effect.forEach(files, (file) => fs.write(under(root, file), file, { createParents: true }), { concurrency: 1, discard: true })
  yield* symlink(under(root, "top.ts"), under(root, "link.ts"))
  yield* symlink(under(root, "src"), under(root, "linked"))
})

/**
 * The FileSystem contract as checks, run against a fresh fixture each:
 * text and bytes round trips (UTF-8 included); `createParents`;
 * `readBytes` ranges; `append`; `rename` (over an existing file, of a
 * directory with what it holds, of a link and not its target, and which
 * side a failure names); `stat` kinds, sizes and links; `exists`;
 * `list` sorted by name with each entry's kind; `glob` with `*`, `**`, `?`,
 * classes, braces, `exclude`, dot entries, `onlyFiles`, `limit` and a
 * linked directory it must not enter; `mkdir` with and without `recursive`;
 * `realPath` through links; the `remove` rules, and the path `remove` acts
 * on (a trailing slash, a linked parent, a last `.` or `..`); and the
 * `reason` and `path` of every failure. Each must finish within 30 seconds;
 * none acts outside the fixture's root, even on a backend that gets the
 * path wrong.
 */
export const fileSystemConformance = (subject: FileSystemSubject): ReadonlyArray<ConformanceCheck> => {
  const fsCheck = (name: string, id: string, body: (fixture: FileSystemFixture, at: (relative: string) => string) => Effect.Effect<void, unknown>): ConformanceCheck =>
    check(name, id, () => Effect.timeoutOrElse(Effect.scoped(subject.open.pipe(Effect.flatMap((fixture) => body(fixture, (relative) => under(fixture.root, relative))))), {
      duration: "30 seconds",
      orElse: () => fail(id, "the check did not finish in 30 seconds"),
    }))
  /** `glob` under the fixture's root returns exactly `expected`, in order, and `truncated`. */
  const globs = (id: string, fixture: FileSystemFixture) => (pattern: string, options: Omit<GlobOptions, "cwd">, expected: ReadonlyArray<string>, truncated = false) =>
    fixture.fs.glob(pattern, { ...options, cwd: fixture.root }).pipe(Effect.flatMap((result: GlobResult) => expect(id,
      result.paths.join("|") === expected.join("|") && result.truncated === truncated,
      `glob ${show(pattern)} ${show(options)} gave ${show(result)}, not ${show({ paths: expected, truncated })}`)))

  return [
    fsCheck("text and bytes read back exactly as written, UTF-8 included, and a write replaces the whole file", "read-write", ({ fs }, at) => Effect.gen(function* () {
      const sample = "héllo ✓ 日本語 🚀\nsecond line\n"
      yield* fs.write(at("text.txt"), sample)
      const back = yield* fs.read(at("text.txt"))
      yield* expect("read-write", back === sample, `read ${show(back)} after writing ${show(sample)}`)
      yield* fs.write(at("text.txt"), "short")
      const replaced = yield* fs.read(at("text.txt"))
      yield* expect("read-write", replaced === "short", `a shorter second write left ${show(replaced)}`)
      const binary = Uint8Array.from([0, 255, 128, 10, 13, 0, 7])
      yield* fs.write(at("data.bin"), binary)
      const raw = yield* fs.readBytes(at("data.bin"))
      yield* expect("read-write", raw.join() === binary.join(), `readBytes returned [${raw.join()}] after writing [${binary.join()}]`)
      const textBytes = yield* fs.readBytes(at("text.txt"))
      yield* expect("read-write", decoded(textBytes) === "short", `readBytes of a text file returned ${show(decoded(textBytes))}`)
      yield* fs.mkdir(at("dir"))
      yield* refuses("read-write", "reading a missing file", fs.read(at("missing.txt")), "NotFound", at("missing.txt"))
      yield* refuses("read-write", "reading a directory", fs.read(at("dir")), "IsDirectory", at("dir"))
      yield* refuses("read-write", "writing over a directory", fs.write(at("dir"), "x"), "IsDirectory", at("dir"))
      yield* fs.write(at("plain"), "a file")
      yield* refuses("read-write", "writing below a file", fs.write(at("plain/inner.txt"), "x"), "NotDirectory", at("plain/inner.txt"))
    })),
    fsCheck("without createParents a missing directory fails with NotFound; with it, write and append create every directory on the way", "create-parents", ({ fs }, at) => Effect.gen(function* () {
      yield* refuses("create-parents", "writing into a missing directory", fs.write(at("a/b/c.txt"), "x"), "NotFound", at("a/b/c.txt"))
      yield* refuses("create-parents", "appending into a missing directory", fs.append(at("a/b/c.txt"), "x"), "NotFound", at("a/b/c.txt"))
      yield* fs.write(at("a/b/c.txt"), "deep", { createParents: true })
      const deep = yield* fs.read(at("a/b/c.txt"))
      const listed = yield* fs.list(at("a"))
      yield* expect("create-parents", deep === "deep" && entries(listed) === "b:directory", `after a createParents write: ${show(deep)}, a/ lists ${entries(listed)}`)
      yield* fs.write(at("a/b/c.txt"), "again", { createParents: true })
      yield* fs.append(at("x/y/log.txt"), "1", { createParents: true })
      const both = [yield* fs.read(at("a/b/c.txt")), yield* fs.read(at("x/y/log.txt"))]
      yield* expect("create-parents", both.join() === "again,1", `createParents over existing directories, and on append, gave ${show(both)}`)
    })),
    fsCheck("readBytes returns the range asked for, what there is of a range past the end, and refuses a negative offset", "read-bytes", ({ fs }, at) => Effect.gen(function* () {
      yield* fs.write(at("digits.txt"), "0123456789")
      const ranges = [{ offset: 2, length: 3 }, { offset: 8 }, { offset: 5, length: 100 }, { offset: 20 }, { offset: 3, length: 0 }, { length: 4 }, {}]
      const read = yield* Effect.forEach(ranges, (range) => fs.readBytes(at("digits.txt"), range).pipe(Effect.map(decoded)), { concurrency: 1 })
      const expected = ["234", "89", "56789", "", "", "0123", "0123456789"]
      yield* expect("read-bytes", read.join("|") === expected.join("|"), `ranges ${show(ranges)} read ${show(read)}, not ${show(expected)}`)
      yield* refuses("read-bytes", "a negative offset", fs.readBytes(at("digits.txt"), { offset: -1 }), "Invalid", at("digits.txt"))
      yield* refuses("read-bytes", "readBytes of a missing file", fs.readBytes(at("missing.bin")), "NotFound", at("missing.bin"))
      yield* fs.mkdir(at("dir"))
      yield* refuses("read-bytes", "readBytes of a directory", fs.readBytes(at("dir")), "IsDirectory", at("dir"))
    })),
    fsCheck("append creates a missing file and adds text and bytes at the end, in order", "append", ({ fs }, at) => Effect.gen(function* () {
      yield* fs.append(at("log.txt"), "one\n")
      yield* fs.append(at("log.txt"), "twö\n")
      yield* fs.append(at("log.txt"), new TextEncoder().encode("three\n"))
      const log = yield* fs.read(at("log.txt"))
      yield* expect("append", log === "one\ntwö\nthree\n", `three appends gave ${show(log)}`)
      yield* fs.write(at("written.txt"), "start")
      yield* fs.append(at("written.txt"), "+end")
      const written = yield* fs.read(at("written.txt"))
      yield* expect("append", written === "start+end", `an append after a write gave ${show(written)}`)
      yield* fs.mkdir(at("dir"))
      yield* refuses("append", "appending to a directory", fs.append(at("dir"), "x"), "IsDirectory", at("dir"))
    })),
    fsCheck("rename moves a file, replaces an existing file at the target, moves a directory with what it holds, moves a link (not its target), and names the side a failure came from", "rename", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* fs.write(at("from.txt"), "moved")
      yield* fs.rename(at("from.txt"), at("to.txt"))
      const moved = [yield* fs.exists(at("from.txt")), yield* fs.read(at("to.txt"))]
      yield* expect("rename", show(moved) === show([false, "moved"]), `after rename: source exists ${show(moved[0])}, target reads ${show(moved[1])}`)
      yield* fs.write(at("new.txt"), "newer")
      yield* fs.rename(at("new.txt"), at("to.txt"))
      const replaced = [yield* fs.exists(at("new.txt")), yield* fs.read(at("to.txt"))]
      yield* expect("rename", show(replaced) === show([false, "newer"]), `renaming over an existing file: source exists ${show(replaced[0])}, target reads ${show(replaced[1])}`)
      yield* fs.write(at("tree/inner/leaf.txt"), "leaf", { createParents: true })
      yield* fs.rename(at("tree"), at("moved-tree"))
      const tree = [yield* fs.exists(at("tree")), yield* fs.read(at("moved-tree/inner/leaf.txt"))]
      yield* expect("rename", show(tree) === show([false, "leaf"]), `renaming a directory: old exists ${show(tree[0])}, moved leaf reads ${show(tree[1])}`)
      yield* fs.write(at("target.txt"), "target")
      yield* symlink(at("target.txt"), at("link"))
      yield* fs.rename(at("link"), at("moved-link"))
      const link = [yield* fs.exists(at("link")), (yield* fs.stat(at("moved-link"), { followSymlinks: false })).kind, yield* fs.read(at("moved-link")), yield* fs.read(at("target.txt"))]
      yield* expect("rename", show(link) === show([false, "symlink", "target", "target"]),
        `renaming a link: old exists ${show(link[0])}, the new path is a ${show(link[1])} reading ${show(link[2])}, its target reads ${show(link[3])}`)
      yield* refuses("rename", "renaming a missing file", fs.rename(at("missing.txt"), at("elsewhere.txt")), "NotFound", at("missing.txt"))
      yield* refuses("rename", "renaming into a missing directory", fs.rename(at("to.txt"), at("missing/to.txt")), "NotFound", at("missing/to.txt"))
      yield* refuses("rename", "renaming a file over a directory", fs.rename(at("to.txt"), at("moved-tree")), "IsDirectory", at("moved-tree"))
      yield* refuses("rename", "renaming a directory over a file", fs.rename(at("moved-tree/inner"), at("to.txt")), "NotDirectory", at("to.txt"))
      yield* fs.mkdir(at("other"))
      yield* refuses("rename", "renaming a directory over one with entries", fs.rename(at("other"), at("moved-tree")), "NotEmpty", at("moved-tree"))
    })),
    fsCheck("stat reports kind, size and time, follows links unless told not to, and a missing path fails with NotFound", "stat", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* fs.write(at("file.txt"), "héllo")
      yield* fs.mkdir(at("dir"))
      yield* symlink(at("file.txt"), at("link"))
      const file = yield* fs.stat(at("file.txt"))
      yield* expect("stat", file.kind === "file" && file.size === 6 && file.path === at("file.txt") && Number.isFinite(file.mtimeMs),
        `stat of a 6-byte file gave ${show({ ...file, mode: undefined })}`)
      const dir = yield* fs.stat(at("dir"))
      yield* expect("stat", dir.kind === "directory", `stat of a directory gave kind ${dir.kind}`)
      const followed = yield* fs.stat(at("link"))
      const link = yield* fs.stat(at("link"), { followSymlinks: false })
      yield* expect("stat", followed.kind === "file" && followed.size === 6 && link.kind === "symlink",
        `stat of a link to a file gave ${followed.kind} (${followed.size} bytes), and without following ${link.kind}`)
      yield* refuses("stat", "stat of a missing path", fs.stat(at("missing")), "NotFound", at("missing"))
    })),
    fsCheck("exists is true for files and directories and false, never an error, for missing paths and dangling links", "exists", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* fs.write(at("file.txt"), "x")
      yield* fs.mkdir(at("dir"))
      yield* symlink(at("nowhere"), at("dangling"))
      const found = yield* Effect.forEach(["file.txt", "dir", "missing", "missing/below", "dangling"], (path) => fs.exists(at(path)), { concurrency: 1 })
      yield* expect("exists", show(found) === show([true, true, false, false, false]), `exists for file, dir, missing, missing/below, dangling link: ${show(found)}`)
    })),
    fsCheck("list returns entries sorted by name with their kinds, links unfollowed; a file fails with NotDirectory and a missing path with NotFound", "list", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* Effect.forEach(["b.txt", "C.txt", "a.txt", ".hidden"], (name) => fs.write(at(`dir/${name}`), name, { createParents: true }), { concurrency: 1, discard: true })
      yield* fs.mkdir(at("dir/a"))
      yield* symlink(at("dir/a"), at("dir/link"))
      const listed = yield* fs.list(at("dir"))
      const expected = ".hidden:file|C.txt:file|a:directory|a.txt:file|b.txt:file|link:symlink"
      yield* expect("list", entries(listed) === expected, `list gave ${entries(listed)}, not ${expected}`)
      const empty = yield* fs.list(at("dir/a"))
      const throughLink = yield* fs.list(at("dir/link"))
      yield* expect("list", empty.length === 0 && throughLink.length === 0, `an empty directory listed ${show(empty)}, and through a link ${show(throughLink)}`)
      yield* refuses("list", "listing a file", fs.list(at("dir/b.txt")), "NotDirectory", at("dir/b.txt"))
      yield* refuses("list", "listing a missing directory", fs.list(at("missing")), "NotFound", at("missing"))
    })),
    fsCheck("glob matches *, ?, classes and braces within a segment, in depth-first order by name", "glob", (fixture) => Effect.gen(function* () {
      yield* globTree(fixture)
      const globbed = globs("glob", fixture)
      yield* globbed("*.ts", { onlyFiles: true }, ["top.ts"])
      yield* globbed("file?.txt", {}, ["file1.txt", "file2.txt"])
      yield* globbed("file[0-1]*.txt", {}, ["file1.txt", "file10.txt"])
      yield* globbed("src/[!a]*.ts", {}, ["src/b.ts"])
      yield* globbed("src/{a,c}.*", {}, ["src/a.ts", "src/c.js"])
      yield* globbed("{top,src/{b,a}}.ts", {}, ["src/a.ts", "src/b.ts", "top.ts"])
      yield* globbed("./docs/*.md", {}, ["docs/x.md"])
    })),
    fsCheck("glob ** crosses directories but never enters a linked directory, and exclude prunes names and paths", "glob-recursive", (fixture) => Effect.gen(function* () {
      yield* globTree(fixture)
      const globbed = globs("glob-recursive", fixture)
      yield* globbed("**/*.ts", { onlyFiles: true }, ["node_modules/m/i.ts", "src/a.ts", "src/b.ts", "src/deep/d.ts", "src/deep/deeper/e.ts", "top.ts"])
      yield* globbed("**/*.ts", { onlyFiles: true, exclude: ["node_modules", "deeper"] }, ["src/a.ts", "src/b.ts", "src/deep/d.ts", "top.ts"])
      yield* globbed("**", { onlyFiles: true, exclude: ["node_modules", "*.txt", "src/deep"] }, ["docs/x.md", "src/a.ts", "src/b.ts", "src/c.js", "top.ts"])
      yield* globbed("linked/**", { onlyFiles: true }, [])
      yield* globbed("src/deep/**", {}, ["src/deep", "src/deep/d.ts", "src/deep/deeper", "src/deep/deeper/e.ts"])
    })),
    fsCheck("glob skips dot entries unless dot is set or the pattern names them with a literal dot", "glob-dot", (fixture) => Effect.gen(function* () {
      yield* globTree(fixture)
      const globbed = globs("glob-dot", fixture)
      yield* globbed("**/*.ts", { onlyFiles: true, exclude: ["node_modules"], dot: true },
        [".hidden/h.ts", "src/.dot.ts", "src/a.ts", "src/b.ts", "src/deep/d.ts", "src/deep/deeper/e.ts", "top.ts"])
      yield* globbed("src/*", { onlyFiles: true, dot: false }, ["src/a.ts", "src/b.ts", "src/c.js"])
      yield* globbed(".hidden/*.ts", {}, [".hidden/h.ts"])
      yield* globbed("src/.*", {}, ["src/.dot.ts"])
    })),
    fsCheck("glob onlyFiles keeps regular files only; without it directories and links that match are listed", "glob-only-files", (fixture) => Effect.gen(function* () {
      yield* globTree(fixture)
      const globbed = globs("glob-only-files", fixture)
      yield* globbed("src/*", {}, ["src/a.ts", "src/b.ts", "src/c.js", "src/deep"])
      yield* globbed("src/*", { onlyFiles: true }, ["src/a.ts", "src/b.ts", "src/c.js"])
      yield* globbed("*.ts", {}, ["link.ts", "top.ts"])
      yield* globbed("l*", {}, ["link.ts", "linked"])
    })),
    fsCheck("glob stops at limit, keeping the first paths in walk order, and reports truncated only when more matched", "glob-limit", (fixture) => Effect.gen(function* () {
      yield* globTree(fixture)
      const globbed = globs("glob-limit", fixture)
      const options = { onlyFiles: true, exclude: ["node_modules"] }
      yield* globbed("**/*.ts", { ...options, limit: 2 }, ["src/a.ts", "src/b.ts"], true)
      yield* globbed("**/*.ts", { ...options, limit: 5 }, ["src/a.ts", "src/b.ts", "src/deep/d.ts", "src/deep/deeper/e.ts", "top.ts"])
      yield* globbed("**/*.ts", { ...options, limit: 0 }, [], true)
      yield* globbed("*.none", { limit: 0 }, [])
    })),
    fsCheck("glob of a missing cwd fails with NotFound, and an absolute or escaping pattern with Invalid", "glob-errors", ({ fs }, at) => Effect.gen(function* () {
      yield* refuses("glob-errors", "glob in a missing cwd", fs.glob("*", { cwd: at("missing") }), "NotFound", at("missing"))
      yield* fs.mkdir(at("dir"))
      yield* refuses("glob-errors", "an absolute pattern", fs.glob("/etc/*", { cwd: at("dir") }), "Invalid")
      yield* refuses("glob-errors", "a pattern with ..", fs.glob("../*", { cwd: at("dir") }), "Invalid")
    })),
    fsCheck("mkdir creates one directory, or with recursive every missing one (idempotently); otherwise an existing path fails with Exists and a missing parent with NotFound", "mkdir", ({ fs }, at) => Effect.gen(function* () {
      yield* fs.mkdir(at("one"))
      yield* refuses("mkdir", "mkdir of an existing directory", fs.mkdir(at("one")), "Exists", at("one"))
      yield* refuses("mkdir", "mkdir with a missing parent", fs.mkdir(at("two/three")), "NotFound", at("two/three"))
      yield* fs.mkdir(at("two/three/four"), { recursive: true })
      yield* fs.mkdir(at("two/three/four"), { recursive: true })
      yield* fs.mkdir(at("one"), { recursive: true })
      const kinds = yield* Effect.forEach(["one", "two", "two/three", "two/three/four"], (path) => fs.stat(at(path)).pipe(Effect.map((info) => info.kind)), { concurrency: 1 })
      yield* expect("mkdir", kinds.every((kind) => kind === "directory"), `after mkdir the paths are ${show(kinds)}`)
      yield* fs.write(at("file"), "x")
      yield* refuses("mkdir", "a recursive mkdir over a file", fs.mkdir(at("file"), { recursive: true }), "Exists", at("file"))
    })),
    fsCheck("realPath resolves every link on the way to the canonical path, and a missing path fails with NotFound", "real-path", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* fs.write(at("target/inner/file.txt"), "x", { createParents: true })
      yield* symlink(at("target"), at("abs-link"))
      yield* symlink("target/inner", at("rel-link"))
      const root = yield* fs.realPath(at(""))
      const resolved = yield* Effect.forEach(["abs-link/inner/file.txt", "rel-link/file.txt", "target"], (path) => fs.realPath(at(path)), { concurrency: 1 })
      const expected = [under(root, "target/inner/file.txt"), under(root, "target/inner/file.txt"), under(root, "target")]
      yield* expect("real-path", show(resolved) === show(expected), `realPath gave ${show(resolved)}, not ${show(expected)}`)
      yield* refuses("real-path", "realPath of a missing path", fs.realPath(at("missing")), "NotFound", at("missing"))
    })),
    fsCheck("remove: a missing path is a no-op, an empty directory goes without recursive, a full one needs it, and a link goes without its target", "remove", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* fs.remove(at("missing"))
      yield* fs.remove(at("missing/below"), { recursive: true })
      yield* fs.write(at("file.txt"), "x")
      yield* fs.remove(at("file.txt"))
      yield* fs.mkdir(at("empty"))
      yield* fs.remove(at("empty"))
      yield* fs.write(at("full/inner/leaf.txt"), "leaf", { createParents: true })
      yield* refuses("remove", "removing a directory with entries without recursive", fs.remove(at("full")), "NotEmpty", at("full"))
      const kept = yield* fs.read(at("full/inner/leaf.txt"))
      yield* symlink(at("full"), at("link"))
      yield* fs.remove(at("link"))
      const afterLink = yield* fs.exists(at("full/inner/leaf.txt"))
      yield* fs.remove(at("full"), { recursive: true })
      const gone = yield* Effect.forEach(["file.txt", "empty", "full", "link"], (path) => fs.exists(at(path)), { concurrency: 1 })
      yield* expect("remove", kept === "leaf" && afterLink && gone.every((exists) => !exists),
        `refused removal kept ${show(kept)}, removing the link kept its target ${show(afterLink)}, removed paths exist ${show(gone)}`)
    })),
    fsCheck("remove acts on the last name as written: a link named with a trailing slash goes without its target, links in the parent are followed, and a path ending in . or .. fails with Invalid", "remove-paths", ({ fs, symlink }, at) => Effect.gen(function* () {
      yield* fs.write(at("dir/sub/leaf.txt"), "leaf", { createParents: true })
      yield* fs.write(at("dir/other/kept.txt"), "kept", { createParents: true })
      yield* symlink(at("dir"), at("link"))
      yield* symlink(at("dir"), at("recursive-link"))
      yield* symlink(at("dir"), at("via"))
      // Only below the fixture's root: `link/..` is the root itself.
      yield* refuses("remove-paths", "removing a path ending in ..", fs.remove(at("dir/sub/.."), { recursive: true }), "Invalid", at("dir/sub/.."))
      yield* refuses("remove-paths", "removing a path ending in .", fs.remove(at("dir/sub/."), { recursive: true }), "Invalid", at("dir/sub/."))
      yield* refuses("remove-paths", "removing a link's parent through ..", fs.remove(at("link/.."), { recursive: true }), "Invalid", at("link/.."))
      yield* fs.remove(at("link/"))
      yield* fs.remove(at("recursive-link/"), { recursive: true })
      yield* fs.remove(at("via/sub"), { recursive: true })
      const links = yield* Effect.forEach(["link", "recursive-link"], (name) => Effect.result(fs.stat(at(name), { followSymlinks: false })).pipe(
        Effect.map((result) => result._tag === "Success" ? result.success.kind : result.failure.reason)), { concurrency: 1 })
      const left = [yield* fs.exists(at("dir/sub")), yield* fs.read(at("dir/other/kept.txt")), (yield* fs.stat(at("via"), { followSymlinks: false })).kind]
      yield* expect("remove-paths", show(links) === show(["NotFound", "NotFound"]) && show(left) === show([false, "kept", "symlink"]),
        `after removing link/ and recursive-link/ they are ${show(links)}; after removing via/sub, dir/sub exists ${show(left[0])}, dir/other/kept.txt reads ${show(left[1])} and via is a ${show(left[2])}`)
    })),
  ]
}
