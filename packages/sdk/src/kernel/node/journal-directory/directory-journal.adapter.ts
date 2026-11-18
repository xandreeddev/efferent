import { randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { Array as Arr, Clock, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { byCreation, JournalStorage, JournalStorageError, Seq, SessionHeader, StoredEvent } from "@xandreed/core/kernel"
import type { Journal, SessionId } from "@xandreed/core/kernel"
import { holdWriter } from "../writer/writer.adapter.js"
import { JournalOpenFailed } from "../writer/writer.entity.js"
import { errorCodeOf, messageOf } from "../writer/writer.entity.functions.js"
import { DIRECTORY_LAYOUT, DIRECTORY_STORE, DirectoryMarker } from "./directory-journal.entity.js"
import type { DirectoryJournalOptions } from "./directory-journal.entity.js"
import { fileNameOf, firstLineOf, isSessionFile, lineOf, linesOf } from "./directory-journal.entity.functions.js"

const headerJson = Schema.fromJsonString(SessionHeader)
const eventJson = Schema.fromJsonString(StoredEvent)
const markerJson = Schema.fromJsonString(DirectoryMarker)
const decodeHeader = Schema.decodeUnknownResult(headerJson)
const decodeEvent = Schema.decodeUnknownResult(eventJson)
const decodeMarker = Schema.decodeUnknownResult(markerJson)
const encodeHeader = Schema.encodeUnknownEffect(headerJson)
const encodeEvent = Schema.encodeUnknownEffect(eventJson)
const encodeMarker = Schema.encodeUnknownEffect(markerJson)

/** The names a directory may hold besides `store.json` while another process is making it a store: the folders it makes first. */
const FRESH_NAMES: ReadonlySet<string> = new Set(["tmp", "writer", "sessions"])
/** How much of a session file a listing reads to find its header line, at a time. */
const HEADER_CHUNK = 4096

const isMissing = (error: unknown) => Option.contains(errorCodeOf(error), "ENOENT")
const isTaken = (error: unknown) => Option.contains(errorCodeOf(error), "EEXIST")

/** One file system call; its failure as it came. */
const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => cause })

/** A file system failure as the store's: the medium could not be reached or written, with what was being done. */
const unavailable = (what: string) => (cause: unknown) =>
  new JournalStorageError({ reason: "Unavailable", message: `${what}: ${messageOf(cause)}` })
const missing = (id: SessionId) => new JournalStorageError({ reason: "SessionMissing", message: `no session ${id}` })
const exists = (id: SessionId) => new JournalStorageError({ reason: "SessionExists", message: `session ${id} exists` })
const unreadable = (file: string, what: string) =>
  new JournalStorageError({ reason: "Unreadable", message: `${file} is not a journal's: ${what}` })

/** Write a new file whole and flush it to the disk; one that is there already fails `EEXIST`. */
const writeSynced = (file: string, bytes: Uint8Array) => call(() => open(file, "wx", 0o600).then((handle) => handle.writeFile(bytes).then(() => handle.sync()).then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
)))

/** Add bytes at a file's end and flush them to the disk before answering. */
const appendSynced = (file: string, bytes: Uint8Array) => call(() => open(file, "a").then((handle) => handle.writeFile(bytes).then(() => handle.datasync()).then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
)))

/** Cut a file at `size` and flush it. */
const cutSynced = (file: string, size: number) => call(() => open(file, "r+").then((handle) => handle.truncate(size).then(() => handle.datasync()).then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
)))

/** Flush a folder's entries, so a file published in it outlives a power loss; a file system that cannot is passed over. */
const syncFolder = (folder: string) => call(() => open(folder, "r").then((handle) => handle.sync().then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
))).pipe(Effect.catch((cause) => Effect.logDebug(`the folder ${folder} could not be flushed`, cause)))

/** Remove a file; one already gone is fine, and any other failure is logged and passed over. */
const removeQuietly = (file: string) => call(() => unlink(file)).pipe(
  Effect.catch((cause) => isMissing(cause) ? Effect.void : Effect.logWarning(`a file of the journal directory could not be removed: ${file}`, cause)),
)

/** The first bytes of a file, up to its first line break or its end. */
const startOf = (file: string) => call(() => open(file, "r").then((handle) => {
  const read = (got: Uint8Array): Promise<Uint8Array> => {
    const buffer = new Uint8Array(HEADER_CHUNK)
    return handle.read(buffer, 0, HEADER_CHUNK, got.length).then(({ bytesRead }) => {
      const joined = new Uint8Array(got.length + bytesRead)
      joined.set(got)
      joined.set(buffer.subarray(0, bytesRead), got.length)
      return bytesRead === 0 || buffer.subarray(0, bytesRead).includes(0x0a) ? joined : read(joined)
    })
  }
  return read(new Uint8Array(0)).then(
    (bytes) => handle.close().then(() => bytes),
    (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
  )
}))

/** A session file read: its header, its events, and the bytes its whole lines take. */
interface SessionFile {
  readonly header: SessionHeader
  readonly events: ReadonlyArray<StoredEvent>
  readonly lines: ReadonlyArray<string>
  readonly whole: number
}

/** Where a session's file ends, as this handle last wrote or read it: its last place, and the file's size and time of change then (a rewrite of the same size changes the time). */
interface Tail {
  readonly seq: number
  readonly size: bigint
  readonly changed: bigint
}

/**
 * A session file's bytes as its journal: the header on the first line, an event on each line after it, numbered
 * from 1 with no gap. A torn tail is left out. A line that is damaged, does not decode, or breaks the numbering
 * is not this store's to guess at: the file is `Unreadable`.
 */
const sessionOf = (file: string, bytes: Uint8Array): Result.Result<SessionFile, JournalStorageError> => Result.flatMap(
  Result.mapError(linesOf(bytes), (damage) => unreadable(file, `line ${damage.line} is not the line that was written`)),
  ({ lines, whole }) => {
    const [first, ...rest] = lines
    if (first === undefined) return Result.fail(unreadable(file, "it holds no header"))
    const header = decodeHeader(first)
    if (Result.isFailure(header)) return Result.fail(unreadable(file, "its first line is no session header"))
    const events: Array<StoredEvent> = []
    for (const [index, line] of rest.entries()) {
      const event = decodeEvent(line)
      if (Result.isFailure(event) || event.success.seq !== index + 1) return Result.fail(unreadable(file, `line ${index + 2} is no event at place ${index + 1}`))
      events.push(event.success)
    }
    return Result.succeed({ header: header.success, events, lines, whole })
  },
)

/**
 * Make sure the directory is a journal store of this layout: one with a `store.json` of this store and layout is;
 * an empty one, or one another opener is making a store, becomes one, its marker published whole by an exclusive
 * hard link; anything else is refused, and nothing is written in it.
 */
const ensureMarker = Effect.fnUntraced(function* (root: string) {
  const marker = join(root, "store.json")
  const refuse = (message: string) => new JournalOpenFailed({ reason: "Format", store: root, message })
  const failed = (what: string) => (cause: unknown) =>
    new JournalOpenFailed({ reason: "Unavailable", store: root, message: `${what}: ${messageOf(cause)}`, cause })
  const check = (text: string) => Result.match(decodeMarker(text), {
    onFailure: () => Effect.fail(refuse(`${marker} is not a journal directory's marker`)),
    onSuccess: (found) => found.store !== DIRECTORY_STORE
      ? Effect.fail(refuse(`${marker} names the store ${JSON.stringify(found.store)}, not a journal directory`))
      : found.layout !== DIRECTORY_LAYOUT
        ? Effect.fail(refuse(`the directory has layout ${found.layout}; this release reads layout ${DIRECTORY_LAYOUT} only, and does not migrate`))
        : Effect.void,
  })
  const read = call(() => readFile(marker, "utf8"))
  const text = yield* read.pipe(Effect.map(Option.some), Effect.catch((cause) => isMissing(cause) ? Effect.succeed(Option.none<string>()) : Effect.fail(failed(`${marker} could not be read`)(cause))))
  if (Option.isSome(text)) return yield* check(text.value)
  const names = yield* Effect.mapError(call(() => readdir(root)), failed(`the directory ${root} could not be listed`))
  const foreign = names.filter((name) => !FRESH_NAMES.has(name))
  if (foreign.length > 0) {
    return yield* Effect.fail(refuse(`the directory holds ${foreign.length === 1 ? "a file" : "files"} (${foreign.slice(0, 3).join(", ")}) and no store.json: it is not a journal directory; give an empty directory, or one that does not exist yet`))
  }
  yield* Effect.mapError(call(() => mkdir(join(root, "tmp"), { recursive: true, mode: 0o700 })), failed(`the folder ${join(root, "tmp")} could not be made`))
  const temporary = join(root, "tmp", `store.json.${randomUUID()}`)
  const written = yield* Effect.orDie(encodeMarker({ store: DIRECTORY_STORE, layout: DIRECTORY_LAYOUT }))
  yield* Effect.mapError(writeSynced(temporary, new TextEncoder().encode(written)), failed(`${temporary} could not be written`))
  yield* call(() => link(temporary, marker)).pipe(
    Effect.catch((cause) => isTaken(cause) ? Effect.void : Effect.fail(failed(`${marker} could not be published`)(cause))),
    Effect.ensuring(removeQuietly(temporary)),
  )
  // Published by this opener or by another one at the same time: read what is there.
  return yield* Effect.flatMap(Effect.mapError(read, failed(`${marker} could not be read`)), check)
})

/**
 * Journals in a directory of files, on Node 24 and Bun: one file per session,
 * its header on the first line and an event on each line after it, each
 * line its CRC-32 and its JSON (ADR 0024).
 *
 * - An append returns once its line is on the disk (`datasync`); a session or
 *   a branch is written whole in `tmp/`, flushed, and published by an
 *   exclusive hard link, so a half-made session never exists, and the
 *   folder is flushed after. The file system must have hard links.
 * - A crash in the middle of an append leaves a torn tail, bytes after the
 *   last line break: a read leaves it out, and the next append cuts it
 *   before it writes. A whole line whose CRC-32 does not match, or that
 *   breaks the numbering, is `Unreadable`, never read past.
 * - One writer per directory, a process: the layer takes the store as it is
 *   built (`writer/`, ADR 0024) and fails with `JournalOpenFailed` (`Held`)
 *   while a running process of this machine, or a process of another
 *   machine, holds it; the store is taken over from a holder whose process
 *   is gone, and let go when the layer's scope closes. Two layers of one
 *   process share the hold, and their writes take one lane.
 * - `store.json` records the store and its layout (`DIRECTORY_LAYOUT`): any
 *   other is refused (`Format`), never read, written or migrated, and so is
 *   a directory that holds other files and no marker.
 *
 * A call waits for the file system without a bound: a mount that stops
 * answering holds it. Each call is one span, `journal_directory.<call>`.
 *
 * @public
 */
export const directoryJournal = (options: DirectoryJournalOptions): Layer.Layer<JournalStorage, JournalOpenFailed> => Layer.effect(JournalStorage, Effect.gen(function* () {
  const root = options.directory
  yield* Effect.mapError(call(() => mkdir(root, { recursive: true, mode: 0o700 })), (cause) =>
    new JournalOpenFailed({ reason: "Unavailable", store: root, message: `the directory ${root} could not be made: ${messageOf(cause)}`, cause }))
  yield* ensureMarker(root)
  const writer = yield* holdWriter(join(root, "writer"), root)
  const sessions = join(root, "sessions")
  const tmp = join(root, "tmp")
  yield* Effect.forEach([sessions, tmp], (folder) => Effect.mapError(call(() => mkdir(folder, { recursive: true, mode: 0o700 })), (cause) =>
    new JournalOpenFailed({ reason: "Unavailable", store: root, message: `the folder ${folder} could not be made: ${messageOf(cause)}`, cause })), { concurrency: 1, discard: true })
  // A file in `tmp/` is a session or a branch whose writer stopped before publishing it. The first handle of the
  // process that holds the store is the only writer there is.
  if (writer.first) {
    const left = yield* call(() => readdir(tmp)).pipe(Effect.catch((cause) => Effect.as(Effect.logWarning(`the folder ${tmp} could not be listed`, cause), [])))
    yield* Effect.forEach(left, (name) => removeQuietly(join(tmp, name)), { concurrency: 1, discard: true })
  }
  const tails = yield* Ref.make<ReadonlyMap<SessionId, Tail>>(new Map())
  const fileOf = (id: SessionId) => join(sessions, fileNameOf(id))

  const readSession = (id: SessionId) => Effect.flatMap(
    call(() => readFile(fileOf(id))).pipe(Effect.mapError((cause) => isMissing(cause) ? missing(id) : unavailable(`${fileOf(id)} could not be read`)(cause))),
    (bytes) => Effect.fromResult(sessionOf(fileOf(id), bytes)).pipe(Effect.map((file) => ({ file, size: bytes.length }))),
  )

  /** The session file's size and time of change (its inode's, in nanoseconds), as the file system has them now. */
  const statOf = (id: SessionId) => call(() => stat(fileOf(id), { bigint: true })).pipe(
    Effect.map((info) => ({ size: info.size, changed: info.ctimeNs })),
    Effect.mapError((cause) => isMissing(cause) ? missing(id) : unavailable(`${fileOf(id)} could not be read`)(cause)),
  )
  /** Remember where a session's file ends after this handle wrote it. */
  const remember = (id: SessionId, seq: number) => Effect.flatMap(statOf(id), (now) => Ref.update(tails, (all) => new Map([...all, [id, { seq, ...now }]])))
  const forget = (id: SessionId) => Ref.update(tails, (all) => new Map([...all].filter(([other]) => other !== id)))

  /**
   * Where the session's file ends now: as this handle left it when the file's size and time of change say nothing
   * else wrote to it, else read again, a torn tail cut first. Called in the lane.
   */
  const tailOf = (id: SessionId) => Effect.gen(function* () {
    const now = yield* statOf(id)
    const known = (yield* Ref.get(tails)).get(id)
    if (known !== undefined && known.size === now.size && known.changed === now.changed) return known
    yield* forget(id)
    const { file, size: read } = yield* readSession(id)
    if (file.whole < read) {
      yield* Effect.mapError(cutSynced(fileOf(id), file.whole), unavailable(`the torn tail of ${fileOf(id)} could not be cut`))
      yield* Effect.logWarning(`a line a write left unfinished was cut from ${fileOf(id)}: ${read - file.whole} bytes after place ${file.events.length}`)
    }
    yield* remember(id, file.events.length)
    return { seq: file.events.length }
  })

  /** Publish a whole new file under `sessions/`: written in `tmp/`, flushed, linked; a name taken is `SessionExists`. */
  const publish = (id: SessionId, lines: ReadonlyArray<Uint8Array>) => Effect.gen(function* () {
    const bytes = new Uint8Array(lines.reduce((sum, line) => sum + line.length, 0))
    lines.reduce((at, line) => { bytes.set(line, at); return at + line.length }, 0)
    const temporary = join(tmp, `${randomUUID()}.jsonl`)
    yield* Effect.mapError(writeSynced(temporary, bytes), unavailable(`${temporary} could not be written`))
    yield* call(() => link(temporary, fileOf(id))).pipe(
      Effect.mapError((cause) => isTaken(cause) ? exists(id) : unavailable(`${fileOf(id)} could not be published`)(cause)),
      Effect.ensuring(removeQuietly(temporary)),
    )
    yield* syncFolder(sessions)
    yield* remember(id, lines.length - 1)
  })

  /** A write: one at a time in the process, and whole once begun, so an interrupted caller never leaves it half done for the next. */
  const write = <A, E>(work: Effect.Effect<A, E>) => writer.lane.withPermits(1)(Effect.uninterruptible(work))

  const headerLine = (header: SessionHeader) => Effect.map(Effect.orDie(encodeHeader(header)), lineOf)

  return JournalStorage.of({
    create: Effect.fn("journal_directory.create")(function* (header) {
      const line = yield* headerLine(header)
      yield* write(publish(header.id, [line]))
    }),
    append: Effect.fn("journal_directory.append")(function* (id, expectedSeq, turn, event) {
      const at = yield* Clock.currentTimeMillis
      const stored: StoredEvent = { seq: Seq.make(expectedSeq + 1), at, turn, ...event }
      const line = lineOf(yield* Effect.orDie(encodeEvent(stored)))
      return yield* write(Effect.gen(function* () {
        const tail = yield* tailOf(id)
        if (tail.seq !== expectedSeq) {
          return yield* Effect.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal is at ${tail.seq}, not ${expectedSeq}` }))
        }
        // A write that failed may have left part of its line: the next one reads the file again and cuts it.
        yield* forget(id)
        yield* Effect.mapError(appendSynced(fileOf(id), line), unavailable(`${fileOf(id)} could not be written`))
        yield* remember(id, stored.seq)
        return stored
      }))
    }),
    read: Effect.fn("journal_directory.read")(function* (id, from) {
      const { file } = yield* readSession(id)
      const journal: Journal = { header: file.header, events: from === undefined ? file.events : file.events.filter((event) => event.seq >= from) }
      return journal
    }),
    list: Effect.gen(function* () {
      const names = yield* Effect.mapError(call(() => readdir(sessions)), unavailable(`the folder ${sessions} could not be listed`))
      const headers = yield* Effect.forEach(names.filter(isSessionFile), (name) => {
        const file = join(sessions, name)
        return startOf(file).pipe(
          Effect.map(Option.some),
          // A file gone between the listing and the read is no session of this listing.
          Effect.catch((cause) => isMissing(cause) ? Effect.succeed(Option.none<Uint8Array>()) : Effect.fail(unavailable(`${file} could not be read`)(cause))),
          Effect.flatMap(Option.match({
            onNone: () => Effect.succeed([]),
            onSome: (start) => Result.match(Result.flatMap(firstLineOf(start), (line) => Result.mapError(decodeHeader(line), () => ({ line: 1 }))), {
              onFailure: () => Effect.fail(unreadable(file, "its first line is no session header")),
              onSuccess: (header) => Effect.succeed([header]),
            }),
          })),
        )
      }, { concurrency: 1 })
      return Arr.sort(headers.flat(), byCreation)
    }).pipe(Effect.withSpan("journal_directory.list")),
    fork: Effect.fn("journal_directory.fork")(function* (header) {
      const line = yield* headerLine(header)
      yield* write(Effect.gen(function* () {
        const taken = yield* call(() => stat(fileOf(header.id))).pipe(
          Effect.as(true),
          Effect.catch((cause) => isMissing(cause) ? Effect.succeed(false) : Effect.fail(unavailable(`${fileOf(header.id)} could not be read`)(cause))),
        )
        if (taken) return yield* Effect.fail(exists(header.id))
        const { of, through } = header.branch
        const { file } = yield* readSession(of)
        if (through > file.events.length) {
          return yield* Effect.fail(new JournalStorageError({ reason: "SeqConflict", message: `the journal of ${of} is at ${file.events.length}, not ${through}` }))
        }
        // The events as they were stored: each line's JSON, as read, under the branch's own header.
        yield* publish(header.id, [line, ...file.lines.slice(1, through + 1).map(lineOf)])
      }))
    }),
  })
}))
