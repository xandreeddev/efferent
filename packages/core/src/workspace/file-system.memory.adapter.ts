import { Clock, Effect, Layer, Match, Option, Ref, Result } from "effect"
import type { Context } from "effect"
import { FsError } from "../domain/file-system.entity.js"
import type { DirEntry, FileInfo, FileKind, FsReason, ReadRange, RecursiveOptions, StatOptions, WriteOptions } from "../domain/file-system.entity.js"
import { FileSystem } from "../ports/file-system.port.js"
import { walkGlob } from "../domain/file-system.entity.functions.js"

type Node =
  | { readonly _tag: "File"; readonly bytes: Uint8Array; readonly mtimeMs: number }
  | { readonly _tag: "Directory"; readonly mtimeMs: number }
  | { readonly _tag: "Symlink"; readonly target: string; readonly mtimeMs: number }

/** Every node by its absolute path; `/` is always a directory. */
type Tree = ReadonlyMap<string, Node>

/** What a seeded path holds: text or bytes (a file), or a symbolic link to `symlink`. */
export type MemorySeed = string | Uint8Array | { readonly symlink: string }

/** The in-memory backend: the port, and a way to make the symbolic links a real disk would have. */
export type MemoryFileSystem = Context.Service.Shape<typeof FileSystem> & {
  /** Create a symbolic link at `path` to `target` (absolute, or relative to the link's directory), as `ln -s target path` does. */
  readonly symlink: (target: string, path: string) => Effect.Effect<void, FsError>
}

const kinds = { File: "file", Directory: "directory", Symlink: "symlink" } as const satisfies Record<Node["_tag"], FileKind>
const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** Links followed in one resolution before it is a loop, as on Linux. */
const maxHops = 40

const failure = (path: string, reason: FsReason, message: string) => new FsError({ path, reason, message })
const segmentsOf = (path: string): ReadonlyArray<string> => path.split("/").filter((segment) => segment.length > 0 && segment !== ".")
const parentOf = (path: string): string => {
  const at = path.lastIndexOf("/")
  return at <= 0 ? "/" : path.slice(0, at)
}
const join = (dir: string, name: string): string => dir === "/" ? `/${name}` : `${dir}/${name}`
/**
 * Whether a path's last segment is `.` or `..`: such a path names a
 * directory only by where it leads (`<link>/..` can be the root), so
 * `remove` refuses it, as `rm` does.
 */
const endsInDots = (path: string): boolean => {
  const last = path.split("/").filter((segment) => segment.length > 0).at(-1)
  return last === "." || last === ".."
}
/** The parent as written (not resolved): what `createParents` creates. */
const writtenParent = (path: string): string => parentOf(`/${segmentsOf(path).join("/")}`)
/** A copy, so neither the caller's later writes nor ours reach the other. */
const bytesOf = (content: string | Uint8Array): Uint8Array => typeof content === "string" ? encoder.encode(content) : Uint8Array.from(content)
const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length)
  joined.set(left)
  joined.set(right, left.length)
  return joined
}
const sizeOf = (node: Node): number => Match.valueTags(node, {
  File: (file) => file.bytes.length,
  Symlink: (link) => encoder.encode(link.target).length,
  Directory: () => 0,
})
const withNode = (tree: Tree, path: string, node: Node): Tree => new Map([...tree, [path, node]])
const inside = (tree: Tree, dir: string): ReadonlyArray<string> => [...tree.keys()].filter((key) => key.startsWith(dir === "/" ? "/" : `${dir}/`) && key !== dir)

/**
 * Where `asked` leads: every link on the way followed, the last one only
 * with `followLast`, and `..` taken after links (as the kernel does). The
 * place may be empty; its directory exists.
 */
const resolveIn = (tree: Tree, asked: string, followLast: boolean): Result.Result<string, FsError> => {
  if (!asked.startsWith("/")) return Result.fail(failure(asked, "Invalid", "paths must be absolute"))
  const step = (current: string, rest: ReadonlyArray<string>, hops: number): Result.Result<string, FsError> => {
    const [name, ...tail] = rest
    if (name === undefined) return Result.succeed(current)
    if (name === "..") return step(parentOf(current), tail, hops)
    const next = join(current, name)
    const node = tree.get(next)
    if (node === undefined) return tail.length === 0 ? Result.succeed(next) : Result.fail(failure(asked, "NotFound", `no such file or directory: ${next}`))
    if (node._tag === "Symlink" && (tail.length > 0 || followLast)) {
      if (hops >= maxHops) return Result.fail(failure(asked, "Invalid", "too many levels of symbolic links"))
      return step("/", [...segmentsOf(node.target.startsWith("/") ? node.target : join(current, node.target)), ...tail], hops + 1)
    }
    if (tail.length > 0 && node._tag === "File") return Result.fail(failure(asked, "NotDirectory", `not a directory: ${next}`))
    return step(next, tail, hops)
  }
  return step("/", segmentsOf(asked), 0)
}

/** Apply a change atomically: what it returns, and the tree after it. */
type Change<A> = readonly [Result.Result<A, FsError>, Tree]
const refused = <A>(tree: Tree, error: FsError): Change<A> => [Result.fail(error), tree]

/**
 * A file system held in memory, with the semantics `fileSystemConformance`
 * checks: for tests, and for hosts that give an agent a scratch workspace
 * that never touches disk. Paths are absolute and POSIX; the tree starts
 * with `/` and the `initial` entries (parents created). Times come from the
 * Effect `Clock`; files report no `mode`.
 */
export const makeMemoryFileSystem = (initial: Readonly<Record<string, MemorySeed>> = {}): Effect.Effect<MemoryFileSystem, FsError> => Effect.gen(function* () {
  const tree = yield* Ref.make<Tree>(new Map([["/", { _tag: "Directory", mtimeMs: yield* Clock.currentTimeMillis }]]))
  const change = <A>(apply: (all: Tree, now: number) => Change<A>): Effect.Effect<A, FsError> =>
    Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.modify(tree, (all) => apply(all, now))), Effect.flatMap(Effect.fromResult))
  const look = <A>(read: (all: Tree) => Result.Result<A, FsError>): Effect.Effect<A, FsError> => Ref.get(tree).pipe(Effect.flatMap((all) => Effect.fromResult(read(all))))
  /** The node a path leads to, links followed; a missing one is `NotFound`. */
  const nodeAt = (all: Tree, asked: string, followLast = true) => Result.flatMap(resolveIn(all, asked, followLast), (real) => Option.match(Option.fromNullishOr(all.get(real)), {
    onNone: () => Result.fail(failure(asked, "NotFound", `no such file or directory: ${asked}`)),
    onSome: (node) => Result.succeed({ real, node }),
  }))
  const fileAt = (all: Tree, asked: string) => Result.flatMap(nodeAt(all, asked), ({ node }) =>
    node._tag === "File" ? Result.succeed(node.bytes) : Result.fail(failure(asked, "IsDirectory", `is a directory: ${asked}`)))

  /**
   * `mkdir -p`: every missing directory on the way, from the top. A link
   * on the way must lead to a directory; one whose target is missing fails
   * with `NotFound` (as on disk), and nothing is created through it. A
   * place still unreachable once its parents are made fails with `NotFound`
   * instead of being tried again.
   */
  const makeDirectories = (asked: string, retried = false): Effect.Effect<void, FsError> => change<"done" | "parent-missing">((all, now) => Result.match(resolveIn(all, asked, false), {
    onFailure: (error) => error.reason === "NotFound" && !retried ? [Result.succeed("parent-missing"), all] : refused(all, error),
    onSuccess: (place) => Option.match(Option.fromNullishOr(all.get(place)), {
      onNone: () => [Result.succeed("done"), withNode(all, place, { _tag: "Directory", mtimeMs: now })],
      onSome: (node) => Match.value(node).pipe(Match.withReturnType<Change<"done" | "parent-missing">>(), Match.tagsExhaustive({
        Directory: () => [Result.succeed("done"), all],
        File: () => refused(all, failure(asked, "Exists", `exists and is not a directory: ${asked}`)),
        Symlink: () => Result.match(nodeAt(all, place), {
          onFailure: (error) => refused(all, failure(asked, error.reason, error.reason === "NotFound" ? `a symbolic link to a missing directory: ${asked}` : error.message)),
          onSuccess: (target) => target.node._tag === "Directory" ? [Result.succeed("done"), all] : refused(all, failure(asked, "Exists", `exists and is not a directory: ${asked}`)),
        }),
      })),
    }),
  })).pipe(Effect.flatMap((outcome) => outcome === "done" ? Effect.void : makeDirectories(writtenParent(asked)).pipe(Effect.andThen(makeDirectories(asked, true)))))

  const put = (asked: string, content: string | Uint8Array, options: WriteOptions | undefined, append: boolean) =>
    (options?.createParents === true ? makeDirectories(writtenParent(asked)) : Effect.void).pipe(Effect.andThen(change<void>((all, now) => Result.match(resolveIn(all, asked, true), {
      onFailure: (error) => refused(all, error),
      onSuccess: (real) => {
        const existing = all.get(real)
        if (existing?._tag === "Directory") return refused(all, failure(asked, "IsDirectory", `is a directory: ${asked}`))
        const before = append && existing?._tag === "File" ? existing.bytes : new Uint8Array()
        return [Result.succeed(undefined), withNode(all, real, { _tag: "File", bytes: concat(before, bytesOf(content)), mtimeMs: now })]
      },
    }))))

  const list = (asked: string): Effect.Effect<ReadonlyArray<DirEntry>, FsError> => look((all) => Result.flatMap(nodeAt(all, asked), ({ real, node }) => node._tag !== "Directory"
    ? Result.fail(failure(asked, "NotDirectory", `not a directory: ${asked}`))
    : Result.succeed(inside(all, real).filter((key) => parentOf(key) === real)
      .map((key): DirEntry => ({ name: key.slice(key.lastIndexOf("/") + 1), kind: kinds[all.get(key)?._tag ?? "File"] }))
      .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0))))

  const readBytes = (asked: string, range?: ReadRange) => {
    const offset = range?.offset ?? 0
    const valid = Number.isInteger(offset) && offset >= 0 && (range?.length === undefined || (Number.isInteger(range.length) && range.length >= 0))
    return valid
      ? look((all) => Result.map(fileAt(all, asked), (bytes) => bytes.slice(offset, range?.length === undefined ? undefined : offset + range.length)))
      : Effect.fail(failure(asked, "Invalid", `offset and length must be whole numbers of at least 0, not ${JSON.stringify(range)}`))
  }

  const rename = (from: string, to: string) => change<void>((all, now) => {
    const source = nodeAt(all, from, false)
    const target = resolveIn(all, to, false)
    if (Result.isFailure(source)) return refused(all, source.failure)
    if (Result.isFailure(target)) return refused(all, target.failure)
    const { real, node } = source.success
    const destination = target.success
    if (real === "/" || destination === "/") return refused(all, failure(real === "/" ? from : to, "Invalid", "the root cannot be moved or replaced"))
    if (destination === real) return [Result.succeed(undefined), all]
    if (destination.startsWith(`${real}/`)) return refused(all, failure(to, "Invalid", `cannot move ${from} into itself`))
    const existing = all.get(destination)
    if (existing !== undefined && node._tag !== "Directory" && existing._tag === "Directory") return refused(all, failure(to, "IsDirectory", `is a directory: ${to}`))
    if (existing !== undefined && node._tag === "Directory" && existing._tag !== "Directory") return refused(all, failure(to, "NotDirectory", `not a directory: ${to}`))
    if (existing?._tag === "Directory" && inside(all, destination).length > 0) return refused(all, failure(to, "NotEmpty", `directory not empty: ${to}`))
    const moved = [real, ...(node._tag === "Directory" ? inside(all, real) : [])]
    const kept = [...all].filter(([key]) => !moved.includes(key) && key !== destination)
    const placed = moved.map((key): readonly [string, Node] => [`${destination}${key.slice(real.length)}`, key === real ? { ...node, mtimeMs: now } : all.get(key) ?? node])
    return [Result.succeed(undefined), new Map([...kept, ...placed])]
  })

  const stat = (asked: string, options?: StatOptions) => look((all) => Result.map(nodeAt(all, asked, options?.followSymlinks !== false), ({ node }): FileInfo => ({
    path: asked, kind: kinds[node._tag], size: sizeOf(node), mtimeMs: node.mtimeMs, mode: Option.none(),
  })))

  const remove = (asked: string, options?: RecursiveOptions) => endsInDots(asked)
    ? Effect.fail(failure(asked, "Invalid", `a path whose last segment is . or .. is never removed: ${asked}`))
    : change<void>((all) => Result.match(resolveIn(all, asked, false), {
      onFailure: (error) => error.reason === "NotFound" ? [Result.succeed(undefined), all] : refused(all, error),
      onSuccess: (real) => {
        const node = all.get(real)
        if (node === undefined) return [Result.succeed(undefined), all]
        if (real === "/") return refused(all, failure(asked, "Invalid", "the root cannot be removed"))
        const below = node._tag === "Directory" ? inside(all, real) : []
        if (below.length > 0 && options?.recursive !== true) return refused(all, failure(asked, "NotEmpty", `directory not empty: ${asked}`))
        const gone = new Set([real, ...below])
        return [Result.succeed(undefined), new Map([...all].filter(([key]) => !gone.has(key)))]
      },
    }))

  const symlink = (target: string, asked: string) => change<void>((all, now) => Result.match(resolveIn(all, asked, false), {
    onFailure: (error) => refused(all, error),
    onSuccess: (real) => all.has(real) ? refused(all, failure(asked, "Exists", `already exists: ${asked}`))
      : [Result.succeed(undefined), withNode(all, real, { _tag: "Symlink", target, mtimeMs: now })],
  }))

  const fs: MemoryFileSystem = {
    read: (asked) => look((all) => Result.map(fileAt(all, asked), (bytes) => decoder.decode(bytes))),
    readBytes,
    write: (asked, content, options) => put(asked, content, options, false),
    append: (asked, content, options) => put(asked, content, options, true),
    rename,
    stat,
    exists: (asked) => look((all) => Result.match(nodeAt(all, asked), {
      onFailure: (error) => error.reason === "NotFound" || error.reason === "NotDirectory" ? Result.succeed(false) : Result.fail(error),
      onSuccess: () => Result.succeed(true),
    })),
    list,
    glob: (pattern, options) => walkGlob(list, pattern, options),
    mkdir: (asked, options) => options?.recursive === true ? makeDirectories(asked) : change<void>((all, now) => Result.match(resolveIn(all, asked, false), {
      onFailure: (error) => refused(all, error),
      onSuccess: (real) => all.has(real) ? refused(all, failure(asked, "Exists", `already exists: ${asked}`))
        : [Result.succeed(undefined), withNode(all, real, { _tag: "Directory", mtimeMs: now })],
    })),
    realPath: (asked) => look((all) => Result.map(nodeAt(all, asked), ({ real }) => real)),
    remove,
    symlink,
  }
  yield* Effect.forEach(Object.entries(initial).toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0), ([path, seed]) =>
    typeof seed === "string" || seed instanceof Uint8Array
      ? fs.write(path, seed, { createParents: true })
      : makeDirectories(writtenParent(path)).pipe(Effect.andThen(symlink(seed.symlink, path))), { concurrency: 1, discard: true })
  return fs
})

/** An empty in-memory `FileSystem` (see `makeMemoryFileSystem`). */
export const FileSystemMemoryLive: Layer.Layer<FileSystem> = Layer.effect(FileSystem, Effect.orDie(makeMemoryFileSystem()))
