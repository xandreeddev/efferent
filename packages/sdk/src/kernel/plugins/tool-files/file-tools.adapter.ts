import { Effect, Match, Result, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { EDIT_FILE, FileList, FilePage, FileWritten, FILE_PAGE, LIST_FILES, LIST_LIMIT, READ_FILE, WRITE_FILE, WRITE_LIMIT, writtenEvent } from "../../contracts/files/files.entity.js"
import type { Expected, FileChanged, FileNotFound, FilePath, FilesRefused, FilesUnavailable } from "../../contracts/files/files.entity.js"
import { editText, fileChanged, filePageOf, filesRefused, listOf, noFileAt, withinLimit, workspaceFolder, workspacePath } from "../../contracts/files/files.entity.functions.js"
import { Files } from "../../contracts/files/files.port.js"
import { CurrentTurn } from "../../contracts/turn/current-turn.port.js"
import { SentWhole } from "../../contracts/turn/sent-whole.port.js"

const PATH = "A path in the workspace, relative to it, with / between folders, such as notes/todo.md."

/**
 * The tool that reads a file of the workspace (ADR 0017), a page at a time. Its answers are sent whole (`SentWhole`):
 * a page is already bounded, so a pointer never stands for one.
 *
 * @public
 */
export const ReadFile = Tool.make(READ_FILE, {
  description: `Read a file of the workspace. Returns \`text\`, the file's characters from \`from\` up to \`to\`, and \`total\`, its length: while \`to\` is less than \`total\`, call again with \`from\` set to \`to\`. One call reads at most ${FILE_PAGE} characters.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: PATH }),
    from: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: "The character to start at: 0, or left out, for the start; then the `to` of the last part you read." })),
  }),
  success: FilePage,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Files],
}).annotate(SentWhole, true)

/**
 * The tool that lists the files of the workspace, or of one folder (ADR 0017).
 *
 * @public
 */
export const ListFiles = Tool.make(LIST_FILES, {
  description: `List the files of the workspace, or of one folder and the folders in it. Returns \`paths\`, in order, and \`more\`, how many were left out: one call lists at most ${LIST_LIMIT}, so give a folder to see the rest.`,
  parameters: Schema.Struct({
    folder: Schema.optionalKey(Schema.String.annotate({ description: "A folder in the workspace, such as notes. Left out, the whole workspace." })),
  }),
  success: FileList,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Files],
})

/**
 * The tool that creates a file or replaces its text (ADR 0017). It asks no one: whether a write is allowed is the
 * app's, which wraps `Files` or asks in its loop. It says each write live about its turn (`plugin.files.written`).
 *
 * @public
 */
export const WriteFile = Tool.make(WRITE_FILE, {
  description: `Create a file of the workspace, or replace all its text. Returns the file's path and how many characters it holds. One call writes at most ${WRITE_LIMIT} characters: write a longer file in parts, the first as it is and each next part with append set to true. To change part of a file, use ${EDIT_FILE}.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: PATH }),
    text: Schema.String.annotate({ description: `The file's text, or with append the part to add at its end. At most ${WRITE_LIMIT} characters.` }),
    append: Schema.optionalKey(Schema.Boolean.annotate({ description: "True to add the text at the end of the file, which must exist. Left out, the text replaces the file's." })),
  }),
  success: FileWritten,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Files, CurrentTurn],
})

/**
 * The tool that changes part of a file (ADR 0017): the one place that holds a text, replaced. The change is made
 * against the text it read: a file written by someone else meanwhile is not overwritten, and the call fails.
 *
 * @public
 */
export const EditFile = Tool.make(EDIT_FILE, {
  description: `Change part of a file of the workspace: the one place that holds \`find\` is replaced with \`replace\`. Returns the file's path and how many characters it now holds. \`find\` must be in the file exactly once, copied from what ${READ_FILE} returned; when it is not, nothing is changed. Each text is at most ${WRITE_LIMIT} characters.`,
  parameters: Schema.Struct({
    path: Schema.String.annotate({ description: PATH }),
    find: Schema.String.annotate({ description: "The text to change, exactly as it is in the file, spaces and line breaks included." }),
    replace: Schema.String.annotate({ description: "The text to put in its place. Empty to remove it." }),
  }),
  success: FileWritten,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Files, CurrentTurn],
})

/**
 * The four file tools: a host merges them into its own toolkit, `Toolkit.merge(tools, fileTools)`, which keeps each
 * tool's type, so a program that leaves `Files` out does not compile where it calls them.
 *
 * @public
 */
export const fileTools = Toolkit.make(ReadFile, ListFiles, WriteFile, EditFile)

/** A failure of `Files` as the model reads it; the medium's own failure is a defect, as a store's is. */
const said = (error: string | FileNotFound | FileChanged | FilesRefused | FilesUnavailable): Effect.Effect<never, string> =>
  typeof error === "string"
    ? Effect.fail(error)
    : Match.valueTags(error, {
      FileNotFound: ({ path }) => Effect.fail(noFileAt(path)),
      FileChanged: ({ path }) => Effect.fail(fileChanged(path)),
      FilesRefused: ({ path, reason }) => Effect.fail(filesRefused(path, reason)),
      FilesUnavailable: (unavailable) => Effect.die(unavailable),
    })

/** Write `text` at `path` as `expected` allows, say so about the turn, and answer what was written. */
const written = Effect.fnUntraced(function* (path: FilePath, text: string, expected?: Expected) {
  const files = yield* Files
  const turn = yield* CurrentTurn
  yield* files.write(path, text, expected)
  // The file is written: a listener that cannot hear of it is logged, and never fails the call.
  yield* turn.publish(writtenEvent, { path }).pipe(Effect.ignoreCause({ log: "Warn", message: "a file's write could not be said" }))
  return { path, characters: text.length }
})

/**
 * What the four tools do, over the `Files` the host provides. A path that is not one in the workspace, a file not
 * there, a text over the limit, a `find` not there once, a file changed meanwhile and a write the workspace declines
 * are failed results the model reads; a medium that fails is a defect.
 *
 * @public
 */
export const fileHandlers = fileTools.toLayer({
  readFile: ({ path, from }) => Effect.gen(function* () {
    const files = yield* Files
    const at = yield* Effect.fromResult(workspacePath(path))
    return yield* Effect.fromResult(filePageOf(at, yield* files.read(at), from ?? 0))
  }).pipe(Effect.catch(said)),
  listFiles: ({ folder }) => Effect.gen(function* () {
    const files = yield* Files
    return listOf(yield* files.list(yield* Effect.fromResult(workspaceFolder(folder))))
  }).pipe(Effect.catch(said)),
  writeFile: ({ path, text, append }) => Effect.gen(function* () {
    const at = yield* Effect.fromResult(workspacePath(path))
    yield* Effect.fromResult(withinLimit("The text", text))
    if (append !== true) return yield* written(at, text)
    const held = yield* (yield* Files).read(at)
    return yield* written(at, held + text, { _tag: "Holds", text: held })
  }).pipe(Effect.catch(said)),
  editFile: ({ path, find, replace }) => Effect.gen(function* () {
    const at = yield* Effect.fromResult(workspacePath(path))
    yield* Effect.fromResult(Result.andThen(withinLimit("The text to find", find), () => withinLimit("The replacement", replace)))
    const held = yield* (yield* Files).read(at)
    return yield* written(at, yield* Effect.fromResult(editText(at, held, find, replace)), { _tag: "Holds", text: held })
  }).pipe(Effect.catch(said)),
})
