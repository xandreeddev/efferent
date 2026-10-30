import { Option, Result } from "effect"
import { errorCodeOf } from "@xandreed/core"
import type { BashExit, FsReason } from "@xandreed/core"
import type { ProcessEnd } from "./local-system.entity.js"

/** A thrown value's message, for the `message` of the error it becomes. */
export const errorMessageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

const reasons: ReadonlyMap<string, FsReason> = new Map<string, FsReason>([
  ["ENOENT", "NotFound"],
  ["EEXIST", "Exists"],
  ["EISDIR", "IsDirectory"],
  ["ERR_FS_EISDIR", "IsDirectory"],
  ["ENOTDIR", "NotDirectory"],
  ["ENOTEMPTY", "NotEmpty"],
  ["EACCES", "Permission"],
  ["EPERM", "Permission"],
  ["EINVAL", "Invalid"],
  ["ELOOP", "Invalid"],
  ["ENAMETOOLONG", "Invalid"],
  ["ERR_INVALID_ARG_VALUE", "Invalid"],
])

/**
 * The `FsReason` of a failed node:fs call, from its error code: `ENOENT`
 * is `NotFound`, `EEXIST` `Exists`, `EISDIR` (and Node's `ERR_FS_EISDIR`)
 * `IsDirectory`, `ENOTDIR` `NotDirectory`, `ENOTEMPTY` `NotEmpty`, `EACCES`
 * and `EPERM` `Permission`; `EINVAL`, a symbolic link loop (`ELOOP`), a
 * name too long and an unusable argument (a path with a NUL byte) are
 * `Invalid`; anything else, or no code at all, is `Io`.
 *
 * @public
 */
export const fsReasonOf = (error: unknown): FsReason => Option.match(errorCodeOf(error), {
  onNone: (): FsReason => "Io",
  onSome: (code) => reasons.get(code) ?? "Io",
})

/**
 * Whether a write to a command's standard input failed only because the
 * command no longer reads it: it exited or closed its input first (`EPIPE`),
 * or the stream was already torn down (`ERR_STREAM_DESTROYED`). The command
 * is free to ignore its input, so these are not failures.
 */
export const isClosedInput = (error: unknown): boolean =>
  Option.match(errorCodeOf(error), { onNone: () => false, onSome: (code) => code === "EPIPE" || code === "ERR_STREAM_DESTROYED" })

/**
 * Where to look for an executable: an absolute path is itself; a bare name
 * is tried in each absolute directory of `path` (a `PATH` value), in order;
 * relative and empty entries, which would depend on the current directory,
 * are skipped, as is a relative name with a slash.
 */
export const executableCandidates = (name: string, path: Option.Option<string>): ReadonlyArray<string> =>
  name.startsWith("/") ? [name]
    : name.includes("/") || name.length === 0 ? []
    : Option.getOrElse(path, () => "").split(":").filter((dir) => dir.startsWith("/")).map((dir) => `${dir.endsWith("/") ? dir.slice(0, -1) : dir}/${name}`)

/**
 * Where `remove(path)` acts, or why it never does. Trailing slashes are
 * ignored, so a link named with one is still the link. The root (`/`, `//`)
 * is refused, and so is a path whose last segment is `.` or `..`: such a
 * path names a directory only by where it leads (`<link>/..` can be the
 * root), so it is never removed. Otherwise the place is the parent as
 * written (to be resolved, links and all) and the last name, never followed.
 */
export const removalPlace = (path: string): Result.Result<{ readonly parent: string, readonly name: string }, string> => {
  const segments = path.split("/").filter((segment) => segment.length > 0)
  return !path.startsWith("/") ? Result.fail(`paths must be absolute: ${path}`)
    : Option.match(Option.fromNullishOr(segments.at(-1)), {
      onNone: () => Result.fail("the root directory is never removed"),
      onSome: (name) => name === "." || name === ".."
        ? Result.fail(`a path whose last segment is ${name} is never removed: ${path}`)
        : Result.succeed({ parent: `/${segments.slice(0, -1).join("/")}`, name }),
    })
}

/** `name` in the directory `dir` (an absolute, resolved path). */
export const pathIn = (dir: string, name: string): string => dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`

/**
 * A process's end as the `BashExit` the stream closes with. A process the
 * adapter killed for its timeout ends `timeout` (it has no exit code, and its
 * signal is the one that killed it); one a signal killed ends `signal`;
 * otherwise it exited, with its code. A process that exited on its own just
 * as its timeout came keeps its exit code and ends `exit`.
 */
export const bashExitOf = (end: ProcessEnd): BashExit => ({
  _tag: "BashExit",
  termination: end.code !== null ? "exit" : end.timedOut ? "timeout" : end.signal !== null ? "signal" : "exit",
  exitCode: Option.fromNullishOr(end.code),
  signal: Option.fromNullishOr(end.signal),
  durationMs: end.durationMs,
})
