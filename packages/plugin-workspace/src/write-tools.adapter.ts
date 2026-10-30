import { Tool } from "effect/ai"
import { Effect, Option, Random, RcMap } from "effect"
import { defineTool, Failure } from "@xandreed/core"
import type { FileInfo, RegisteredTool } from "@xandreed/core"
import { applyTextEdits, unifiedDiff } from "./text-edit.entity.functions.js"
import { decodeText, encodeText, formatBytes, looksBinary, utf8Length } from "./text-window.entity.functions.js"
import { checkWritable, fsFailure, openWorkspace, resolveTarget } from "./workspace-path.entity.functions.js"
import type { WorkspaceAccess } from "./workspace-path.entity.functions.js"
import type { WorkspaceTarget } from "./workspace-path.entity.js"
import { EditParams, EditResult, WORKSPACE_PERMISSIONS, WriteParams, WriteResult } from "./workspace-tools.entity.js"
import { compactEdit, compactWrite, renderEdit, renderWrite, toolDescriptions } from "./workspace-tools.entity.functions.js"
import { failure, fileSubjects, notAFile, WORKSPACE_SERVICES } from "./read-tools.adapter.js"
import type { WorkspaceToolContext } from "./read-tools.adapter.js"

const WriteTool = (description: string) => Tool.make("write", { description, parameters: WriteParams, success: WriteResult, failure: Failure, failureMode: "return" })
const EditTool = (description: string) => Tool.make("edit", { description, parameters: EditParams, success: EditResult, failure: Failure, failureMode: "return" })

/**
 * Run `change` holding the lock of the file at `path` (its real path), so
 * two calls changing one file, from any turn of any session this capability
 * serves, never interleave their read and write.
 */
const holding = (context: WorkspaceToolContext, path: string) => <A, E, R>(change: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.scoped(RcMap.get(context.locks, path).pipe(Effect.flatMap((lock) => lock.withPermits(1)(change))))

/** What is at the path now: none when nothing is. */
const existing = (access: WorkspaceAccess, target: WorkspaceTarget): Effect.Effect<Option.Option<FileInfo>, Failure> =>
  access.fs.stat(target.path).pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.reason === "NotFound", () => Effect.succeed(Option.none<FileInfo>())),
    Effect.mapError(fsFailure(target.display)),
  )

/** Permission bits a file `write` creates can never have (`0o666` at most, whatever the umask): execute, setuid, setgid, sticky. */
const notForNewFiles = 0o7111

/**
 * Write a file's new content. It is written beside its place under a
 * temporary name and renamed over it, so a reader never sees half of it,
 * when the file is new, when the backend reports no permissions, or when
 * the temporary file came out with the very permissions the file has. A
 * file whose permissions a rename would change (an executable script, a
 * private or read-only file, any mode the umask does not give a new file)
 * is written in place instead, keeping them; when its mode has bits a new
 * file never gets, without trying the temporary file first.
 */
const save = (access: WorkspaceAccess, target: WorkspaceTarget, content: string, before: Option.Option<FileInfo>): Effect.Effect<void, Failure> => {
  const mode = Option.flatMap(before, (info) => info.mode)
  const inPlace = access.fs.write(target.path, content)
  const replaced = Effect.gen(function* () {
    const suffix = (yield* Random.nextIntBetween(0, 2_147_483_647)).toString(36)
    const temporary = access.path.join(access.path.dirname(target.path), `.${access.path.basename(target.path)}.${suffix}.efferent-tmp`)
    const discard = access.fs.remove(temporary).pipe(Effect.ignore({ log: "Warn", message: `the temporary file ${temporary} was not removed` }))
    yield* access.fs.write(temporary, content, { createParents: true })
    const same = yield* Option.match(mode, {
      onNone: () => Effect.succeed(true),
      onSome: (kept) => access.fs.stat(temporary).pipe(Effect.map((fresh) => Option.contains(fresh.mode, kept)), Effect.tapError(() => discard)),
    })
    if (!same) return yield* discard.pipe(Effect.andThen(inPlace))
    yield* access.fs.rename(temporary, target.path).pipe(Effect.tapError(() => discard))
  })
  const written = Option.exists(mode, (bits) => (bits & notForNewFiles) !== 0) ? inPlace : replaced
  return written.pipe(Effect.mapError(fsFailure(target.display)))
}

/** `write`: create a file, or replace all of one, through a temporary file and a rename (see `save`). */
export const writeTool = (context: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: WriteTool(toolDescriptions(context.config).write),
  requires: WORKSPACE_SERVICES,
  handler: (params) => Effect.gen(function* () {
    const access = yield* openWorkspace(context.path, context.config)
    const target = yield* resolveTarget(access, params.path, { confine: context.config.confine, intent: "write" })
    yield* checkWritable(access, target, context.protect)
    return yield* holding(context, target.path)(Effect.gen(function* () {
      const before = yield* existing(access, target)
      if (Option.exists(before, (info) => info.kind === "directory")) return yield* Effect.fail(failure("IsDirectory", `${target.display} is a directory; write takes the path of a file`))
      if (Option.exists(before, (info) => info.kind !== "file")) return yield* Effect.fail(notAFile(target.display, "write"))
      if (params.content.length === 0 && Option.exists(before, (info) => info.size > 0)) {
        return yield* Effect.fail(failure("WouldEmpty", `${target.display} has content; write refuses to empty it. Use edit to remove parts of it, or bash to delete it`))
      }
      yield* save(access, target, params.content, before)
      return { path: target.display, bytes: utf8Length(params.content), created: Option.isNone(before) }
    }))
  }),
  view: { version: "1", render: renderWrite, compact: compactWrite, subjects: (result) => fileSubjects(result.path) },
  annotations: { permissions: [WORKSPACE_PERMISSIONS.write] },
})

/**
 * `edit`: exact replacements in a UTF-8 text file, all matched against the
 * file as it was, with the BOM and line endings kept. A file that is not
 * valid UTF-8 is refused (`NotUtf8`): writing its decoded text back would
 * turn every byte that is not into U+FFFD, lines the edits never touched
 * included.
 */
export const editTool = (context: WorkspaceToolContext): RegisteredTool => defineTool({
  tool: EditTool(toolDescriptions(context.config).edit),
  requires: WORKSPACE_SERVICES,
  handler: (params) => Effect.gen(function* () {
    const { config } = context
    const access = yield* openWorkspace(context.path, context.config)
    const target = yield* resolveTarget(access, params.path, { confine: config.confine, intent: "write" })
    yield* checkWritable(access, target, context.protect)
    return yield* holding(context, target.path)(Effect.gen(function* () {
      const before = yield* existing(access, target)
      const info = yield* Option.match(before, {
        onNone: () => Effect.fail(failure("NotFound", `${target.display} does not exist; use write to create it`)),
        onSome: Effect.succeed,
      })
      if (info.kind === "directory") return yield* Effect.fail(failure("IsDirectory", `${target.display} is a directory; edit takes the path of a file`))
      if (info.kind !== "file") return yield* Effect.fail(notAFile(target.display, "edit"))
      if (info.size > config.maxFileBytes) {
        return yield* Effect.fail(failure("FileTooLarge", `${target.display} is ${formatBytes(info.size)}, more than the ${formatBytes(config.maxFileBytes)} edit loads; change it with bash (sed -i, or a script)`))
      }
      const bytes = yield* access.fs.readBytes(target.path).pipe(Effect.mapError(fsFailure(target.display)))
      if (looksBinary(bytes)) return yield* Effect.fail(failure("BinaryFile", `${target.display} is a binary file; edit changes text files only`))
      const decoded = decodeText(bytes)
      if (decoded.lossy) {
        return yield* Effect.fail(failure("NotUtf8", `${target.display} is not valid UTF-8 (Latin-1 or another encoding, say); edit changes UTF-8 text files only, since it would replace the bytes it cannot decode. Use bash (sed, iconv) to change it`))
      }
      const plan = yield* Effect.fromResult(applyTextEdits(decoded.text, params.edits, { fuzzy: config.fuzzyEdit }))
      yield* save(access, target, encodeText({ text: plan.text, bom: decoded.bom }), before)
      return {
        path: target.display, replaced: plan.replaced, normalized: plan.normalized, firstChangedLine: plan.firstChangedLine,
        diff: unifiedDiff(target.display, plan.before, plan.after, config.maxBytes),
      }
    }))
  }),
  view: { version: "1", render: renderEdit, compact: compactEdit, subjects: (result) => fileSubjects(result.path) },
  annotations: { permissions: [WORKSPACE_PERMISSIONS.write] },
})
