import { Option, Result, Schema } from "effect"
import { pageAt } from "../memory/pointer.entity.functions.js"
import { FilePath, FILE_PAGE, LIST_FILES, LIST_LIMIT, READ_FILE, WRITE_FILE, WRITE_LIMIT } from "./files.entity.js"
import type { FileList, FilePage } from "./files.entity.js"

const filePath = Schema.decodeUnknownOption(FilePath)

/** A text of the model's as a failure repeats it: its start, and how much was left out. */
const shown = (text: string, limit: number): string => {
  if (text.length <= limit) return JSON.stringify(text)
  const end = (text.charCodeAt(limit - 1) & 0xfc00) === 0xd800 ? limit - 1 : limit
  return `${JSON.stringify(text.slice(0, end))} [… ${text.length - end} characters clipped]`
}

/**
 * What a file tool answers for a path that is not one in the workspace: one that starts at the root, holds a `..`
 * or a character no path takes, or is longer than a path may be.
 */
export const notInWorkspace = (text: string): string =>
  `The path ${shown(text, 80)} is not a path in the workspace. Give a path relative to the workspace, with / between folders and no "..", such as notes/todo.md.`

/**
 * A model's path as a path in the workspace (ADR 0017), or the words that refuse it. Empty names and `.` between
 * slashes are dropped (`./notes//a.md` is `notes/a.md`); a path that starts at the root, or holds `..`, is refused,
 * since it would leave the workspace; so is one with a `\`, a `:` or a control character, or longer than
 * `PATH_LIMIT`.
 *
 * @public
 */
export const workspacePath = (text: string): Result.Result<FilePath, string> => {
  if (text.startsWith("/")) return Result.fail(notInWorkspace(text))
  const names = text.split("/").filter((name) => name !== "" && name !== ".")
  return Option.match(filePath(names.join("/")), {
    onNone: () => Result.fail(notInWorkspace(text)),
    onSome: Result.succeed,
  })
}

/** A folder a model named for `listFiles`, or none for the whole workspace: an empty name or `.` is the whole. */
export const workspaceFolder = (text: string | undefined): Result.Result<Option.Option<FilePath>, string> => {
  const names = (text ?? "").split("/").filter((name) => name !== "" && name !== ".")
  return names.length === 0 && !(text ?? "").startsWith("/") ? Result.succeed(Option.none()) : Result.map(workspacePath(text ?? ""), Option.some)
}

/** Whether `path` is in the folder `folder` (or any folder in it); every path is in the workspace, `none`. */
export const inFolder = (path: FilePath, folder: Option.Option<FilePath>): boolean =>
  Option.match(folder, { onNone: () => true, onSome: (name) => path.startsWith(`${name}/`) })

/** What a file tool answers for a path no file is at. */
export const noFileAt = (path: FilePath): string => `No file is at ${path}. Call ${LIST_FILES} to see the files.`

/** What `readFile` answers when asked to start at or past the end of a file. */
export const pastTheEndOf = (path: FilePath, total: number): string => `${path} is ${total} characters long: from must be less than ${total}.`

/**
 * A page of a file: up to `FILE_PAGE` characters of its text from `from`, never half a character, or why there is
 * none (`from` past its end). An empty file has one page, from 0: nothing.
 */
export const filePageOf = (path: FilePath, text: string, from: number): Result.Result<FilePage, string> =>
  from >= text.length && from > 0
    ? Result.fail(pastTheEndOf(path, text.length))
    : Result.succeed({ path, ...pageAt(text, from, FILE_PAGE), total: text.length })

/** The paths `listFiles` answers: the first `LIST_LIMIT` in order, and how many it left out. */
export const listOf = (paths: ReadonlyArray<FilePath>): FileList => ({ paths: paths.slice(0, LIST_LIMIT), more: Math.max(0, paths.length - LIST_LIMIT) })

/** What `writeFile` or `editFile` answers for a text over `WRITE_LIMIT`. */
export const tooLong = (what: string, characters: number): string =>
  `${what} is ${characters} characters long, and one call takes at most ${WRITE_LIMIT}. Write a longer file in parts: call ${WRITE_FILE} with the first part, then with each next part and append set to true.`

/** A text a call carries, held to `WRITE_LIMIT`, or the words that refuse it. */
export const withinLimit = (what: string, text: string): Result.Result<string, string> =>
  text.length > WRITE_LIMIT ? Result.fail(tooLong(what, text.length)) : Result.succeed(text)

/** What `editFile` answers for a text to find that is empty. */
export const FIND_EMPTY = `The text to find is empty: copy the text to change from what ${READ_FILE} returned.`

/** What `editFile` answers for a text to find that is not in the file. */
export const findMissing = (path: FilePath): string =>
  `The text to find is not in ${path}, so nothing was changed. Call ${READ_FILE} and copy the text exactly, spaces and line breaks included.`

/** What `editFile` answers for a text to find that is in the file more than once. */
export const findMany = (path: FilePath, times: number): string =>
  `The text to find is in ${path} ${times} times, so nothing was changed. Give more of the text around the place to change, so that it is there once.`

/** What a write answers when the file changed while it was being edited: another writer got there first. */
export const fileChanged = (path: FilePath): string =>
  `${path} was changed by someone else while it was being edited, so nothing was written. Call ${READ_FILE} and edit it again.`

/** What a file tool answers when the workspace declines it, with the host's reason, cut if long. */
export const filesRefused = (path: FilePath, reason: string): string =>
  `The workspace declined this for ${path}: ${shown(reason, 200)}. Do not try it again unless the user asks for it.`

/** How many times `find` is in `text`, counting places that do not overlap, from the start. */
const timesIn = (text: string, find: string): number => {
  let times = 0
  let at = text.indexOf(find)
  while (at !== -1) {
    times += 1
    at = text.indexOf(find, at + find.length)
  }
  return times
}

/**
 * `text` with the one place that holds `find` replaced by `replace`, or the words that refuse it: `find` empty, not
 * in the text, or there more than once. The replacement is taken as it is (no `$` pattern is read in it).
 */
export const editText = (path: FilePath, text: string, find: string, replace: string): Result.Result<string, string> => {
  if (find.length === 0) return Result.fail(FIND_EMPTY)
  const times = timesIn(text, find)
  if (times === 0) return Result.fail(findMissing(path))
  if (times > 1) return Result.fail(findMany(path, times))
  const at = text.indexOf(find)
  return Result.succeed(text.slice(0, at) + replace + text.slice(at + find.length))
}
