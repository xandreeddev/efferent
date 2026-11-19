import { Schema } from "effect"
import { liveEvent } from "@xandreed/core"

/**
 * The most characters of a path in the workspace: short enough that an app's approval key of a path (an action is
 * at most 200 characters) has room for a name of its own before it.
 *
 * @public
 */
export const PATH_LIMIT = 160

/**
 * A path in the workspace (ADR 0017), the only form a `Files` is given: relative to the workspace, folders joined
 * by `/`, each name not empty, not `.` and not `..`, with no `\`, no `:` and no control character, at most
 * `PATH_LIMIT` characters. Such a path cannot leave the workspace, on any medium a host keeps it on. A model's text
 * becomes one through `workspacePath`, which says why it does not.
 *
 * @public
 */
export const FilePath = Schema.String.check(
  Schema.isPattern(/^(?!\.\.?(?:\/|$))(?![^]*\/\.\.?(?:\/|$))[^/\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]+(?:\/[^/\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]+)*$/),
  Schema.isMaxLength(PATH_LIMIT),
).pipe(Schema.brand("FilePath"))
export type FilePath = typeof FilePath.Type

/**
 * What a write expects the file to hold before it, for a write that must not replace a change it has not seen
 * (`Files.write`): no file (`Absent`), or exactly this text (`Holds`).
 *
 * @public
 */
export const Expected = Schema.Union([
  Schema.TaggedStruct("Absent", {}),
  Schema.TaggedStruct("Holds", { text: Schema.String }),
])
export type Expected = typeof Expected.Type

/**
 * No file is at the path.
 *
 * @public
 */
export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  path: FilePath,
  message: Schema.String,
}) {}

/**
 * The file does not hold what the write expected: someone else wrote it since it was read. Nothing was written.
 *
 * @public
 */
export class FileChanged extends Schema.TaggedError<FileChanged>()("FileChanged", {
  path: FilePath,
  message: Schema.String,
}) {}

/**
 * This `Files` declines the read or the write, by a rule of the host's (a folder kept from the agent, a workspace
 * that is read-only), and says why in `reason`. Nothing was read or written. The kernel's file tools hand the reason
 * to the model as the call's failed result.
 *
 * @public
 */
export class FilesRefused extends Schema.TaggedError<FilesRefused>()("FilesRefused", {
  path: FilePath,
  reason: Schema.String,
  message: Schema.String,
}) {}

/**
 * The medium that holds the files failed. A tool's call that meets it is a defect, as a store's failure is.
 *
 * @public
 */
export class FilesUnavailable extends Schema.TaggedError<FilesUnavailable>()("FilesUnavailable", {
  message: Schema.String,
}) {}

/**
 * The most characters one call of `readFile` reads.
 *
 * @public
 */
export const FILE_PAGE = 4000

/**
 * The most characters of text one call of `writeFile` or `editFile` carries. That text is in the call, which the
 * journal keeps and every later prompt sends whole, so a longer file is written in parts.
 *
 * @public
 */
export const WRITE_LIMIT = 4000

/**
 * The most paths one call of `listFiles` gives.
 *
 * @public
 */
export const LIST_LIMIT = 200

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * What `readFile` answers: the file's characters from `from` up to `to`, of `total`. The next part starts at `to`;
 * the file is read to its end when `to` is `total`.
 *
 * @public
 */
export const FilePage = Schema.Struct({ path: FilePath, text: Schema.String, from: Offset, to: Offset, total: Offset })
export type FilePage = typeof FilePage.Type

/**
 * What `listFiles` answers: the paths, in order, and how many more there were past `LIST_LIMIT`.
 *
 * @public
 */
export const FileList = Schema.Struct({ paths: Schema.Array(FilePath), more: Offset })
export type FileList = typeof FileList.Type

/**
 * What `writeFile` and `editFile` answer: the file written, and how many characters it now holds.
 *
 * @public
 */
export const FileWritten = Schema.Struct({ path: FilePath, characters: Offset })
export type FileWritten = typeof FileWritten.Type

/**
 * The data of `plugin.files.written`: the file a tool wrote.
 *
 * @public
 */
export const WrittenData = Schema.Struct({ path: FilePath })
export type WrittenData = typeof WrittenData.Type

/**
 * `plugin.files.written`: a tool wrote a file, said live about its turn and stored nowhere (the call and its result
 * are the record). A client that shows the workspace reads `Files` again when it hears it.
 *
 * @public
 */
export const writtenEvent = liveEvent("files", "written", { data: WrittenData, tags: ["trace"] })

/**
 * The name of the tool that reads a file.
 *
 * @public
 */
export const READ_FILE = "readFile"

/**
 * The name of the tool that lists files.
 *
 * @public
 */
export const LIST_FILES = "listFiles"

/**
 * The name of the tool that writes a file.
 *
 * @public
 */
export const WRITE_FILE = "writeFile"

/**
 * The name of the tool that changes part of a file.
 *
 * @public
 */
export const EDIT_FILE = "editFile"
