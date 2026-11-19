import { randomUUID } from "node:crypto"
import { link, mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { Array as Arr, Clock, Effect, Option, Order, Ref, Result, Schema, Semaphore } from "effect"
import type { Scope } from "effect"
import { Holder, JournalOpenFailed } from "./writer.entity.js"
import type { Found, ThisProcess } from "./writer.entity.js"
import { errorCodeOf, holderNumberOf, messageOf, verdictOf } from "./writer.entity.functions.js"

/**
 * What a handle holds of a store: the lane the process's writes to the store
 * take one at a time, whichever of its handles makes them, and whether this
 * handle took the store (`first`) or joined a handle of the same process
 * that holds it.
 */
export interface HeldWriter {
  readonly lane: Semaphore.Semaphore
  readonly first: boolean
}

/** A store this process holds: its lane, its holder file, and how many handles of the process have it open. */
interface Holding {
  readonly lane: Semaphore.Semaphore
  readonly file: string
  readonly handles: number
}

/**
 * The stores this process holds, by their writer folder's real path. The writer of a store is a process: two
 * handles of one process share its hold and its lane, as they share the process's files.
 */
const holdings = Ref.makeUnsafe<ReadonlyMap<string, Holding>>(new Map())
/** One open or close at a time in the process, so two handles opened at once never both take the store. */
const opening = Semaphore.makeUnsafe(1)
const me: ThisProcess = { pid: process.pid, host: hostname() }
/** How many times an open looks again when the lock changed hands under it, before it gives up. */
const TRIES = 5
/** A file being written that its writer left (it stopped between writing and publishing it) is removed once this old. */
const LEFT_OVER_MS = 600_000

const decodeHolder = Schema.decodeUnknownResult(Schema.fromJsonString(Holder))
const encodeHolder = Schema.encodeUnknownEffect(Schema.fromJsonString(Holder))
const isMissing = (error: unknown) => Option.contains(errorCodeOf(error), "ENOENT")

/** One file system call; its failure as it came. */
const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (cause) => cause })

/** Remove a file; one already gone is fine, and any other failure is logged and passed over. */
const removeQuietly = (file: string) => call(() => unlink(file)).pipe(
  Effect.catch((cause) => isMissing(cause) ? Effect.void : Effect.logWarning(`a writer file could not be removed: ${file}`, cause)),
)

/** Whether a process of this machine is running: one the system says is not there is gone; one it will not signal is someone else's, and runs. */
const isAlive = (pid: number) => Effect.try({ try: () => process.kill(pid, 0), catch: (cause) => cause }).pipe(
  Effect.match({ onSuccess: () => true, onFailure: (cause) => !Option.contains(errorCodeOf(cause), "ESRCH") }),
)

/** Write a new file whole and flush it to the disk before it is published. */
const writeSynced = (file: string, text: string) => call(() => open(file, "wx", 0o600).then((handle) => handle.writeFile(text).then(() => handle.sync()).then(
  () => handle.close(),
  (error: unknown) => handle.close().then(() => Promise.reject(error), () => Promise.reject(error)),
)))

/**
 * Take a store as its writer, in its writer folder: the holder file with the highest number names the holder.
 * A process takes the store by publishing the next number, by an exclusive hard link of a file written whole, so of
 * two processes that found the same holder gone exactly one publishes; then it lists again, and gives way to a
 * higher number published meanwhile (one published from an older listing). It removes the lower numbers, and a
 * file being written that is old enough to have been left.
 */
const take = Effect.fnUntraced(function* (folder: string, store: string) {
  const unavailable = (what: string) => (cause: unknown) =>
    new JournalOpenFailed({ reason: "Unavailable", store, message: `${what}: ${messageOf(cause)}`, cause })
  const fileOf = (number: number) => join(folder, `${number}.json`)
  const numbers = Effect.map(
    Effect.mapError(call(() => readdir(folder)), unavailable(`the writer folder ${folder} could not be listed`)),
    (names) => Arr.sort(names.flatMap((name) => Option.toArray(holderNumberOf(name))), Order.flip(Order.Number)),
  )
  /** The highest holder file, read; none when it went away between the listing and the read (its holder closed). */
  const highest = (found: ReadonlyArray<number>) => Option.match(Arr.head(found), {
    onNone: () => Effect.succeed(Option.some<Found>({ _tag: "None" })),
    onSome: (number) => call(() => readFile(fileOf(number), "utf8")).pipe(
      Effect.map((text) => Option.some(Result.match(decodeHolder(text), {
        onSuccess: (holder): Found => ({ _tag: "Holding", number, holder }),
        onFailure: (): Found => ({ _tag: "Unreadable", number }),
      }))),
      Effect.catch((cause) => isMissing(cause) ? Effect.succeed(Option.none<Found>()) : Effect.fail(unavailable(`the lock file ${fileOf(number)} could not be read`)(cause))),
    ),
  })
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const listed = yield* numbers
    const read = yield* highest(listed)
    if (Option.isNone(read)) continue
    const found = read.value
    const alive = found._tag === "Holding" && found.holder.host === me.host && found.holder.pid !== me.pid ? yield* isAlive(found.holder.pid) : false
    const verdict = verdictOf(found, me, alive, fileOf)
    if (verdict._tag === "Held") return yield* Effect.fail(new JournalOpenFailed({ reason: "Held", store, message: `the store is ${verdict.why}` }))
    const token = randomUUID()
    const text = yield* Effect.orDie(encodeHolder({ ...me, token, since: yield* Clock.currentTimeMillis }))
    const temporary = join(folder, `${verdict.number}.json.${token}.tmp`)
    yield* Effect.mapError(writeSynced(temporary, text), unavailable(`the lock file ${temporary} could not be written`))
    const published = yield* call(() => link(temporary, fileOf(verdict.number))).pipe(
      Effect.as(true),
      Effect.catch((cause) => Option.contains(errorCodeOf(cause), "EEXIST") ? Effect.succeed(false) : Effect.fail(unavailable(`the lock file ${fileOf(verdict.number)} could not be published`)(cause))),
      Effect.ensuring(removeQuietly(temporary)),
    )
    if (!published) continue
    const after = yield* numbers
    if (after.some((other) => other > verdict.number)) {
      yield* removeQuietly(fileOf(verdict.number))
      continue
    }
    yield* Effect.forEach(after.filter((other) => other < verdict.number), (other) => removeQuietly(fileOf(other)), { concurrency: 1, discard: true })
    yield* sweepLeftOver(folder)
    return fileOf(verdict.number)
  }
  return yield* Effect.fail(new JournalOpenFailed({ reason: "Held", store, message: `the store's writer changed ${TRIES} times while it was being opened: open it again` }))
})

/** Remove the files a taker left between writing and publishing them (`<n>.json.<token>.tmp`), once they are old enough to be no live taker's. */
const sweepLeftOver = (folder: string) => Effect.gen(function* () {
  const names = yield* call(() => readdir(folder))
  const now = yield* Clock.currentTimeMillis
  yield* Effect.forEach(names.filter((name) => /^\d+\.json\..+\.tmp$/.test(name)), (name) =>
    call(() => stat(join(folder, name))).pipe(
      Effect.flatMap((info) => now - info.mtimeMs > LEFT_OVER_MS ? removeQuietly(join(folder, name)) : Effect.void),
    ), { concurrency: 1, discard: true })
}).pipe(Effect.catch((cause) => Effect.logWarning(`the writer folder ${folder} could not be swept`, cause)))

/**
 * Hold a store as its one writer for the scope: the store's writer folder, `folder`, names its holder. The first
 * handle of this process takes the store (`take`); a later one joins it, sharing its lane; the store is let go
 * when the last handle closes, its holder file removed. Refused (`Held`) while a process of this machine that is
 * running, or a process of another machine, holds it; taken over from a holder whose process is gone. `store` is
 * the path a refusal names.
 */
export const holdWriter = (folder: string, store: string): Effect.Effect<HeldWriter, JournalOpenFailed, Scope.Scope> =>
  Effect.acquireRelease(
    opening.withPermits(1)(Effect.gen(function* () {
      yield* Effect.mapError(call(() => mkdir(folder, { recursive: true, mode: 0o700 })), (cause) =>
        new JournalOpenFailed({ reason: "Unavailable", store, message: `the writer folder ${folder} could not be made: ${messageOf(cause)}`, cause }))
      const key = yield* Effect.mapError(call(() => realpath(folder)), (cause) =>
        new JournalOpenFailed({ reason: "Unavailable", store, message: `the writer folder ${folder} could not be found: ${messageOf(cause)}`, cause }))
      const joined = (yield* Ref.get(holdings)).get(key)
      if (joined !== undefined) {
        yield* Ref.update(holdings, (all) => new Map([...all, [key, { ...joined, handles: joined.handles + 1 }]]))
        return { key, writer: { lane: joined.lane, first: false } }
      }
      const file = yield* take(key, store)
      const lane = yield* Semaphore.make(1)
      yield* Ref.update(holdings, (all) => new Map([...all, [key, { lane, file, handles: 1 }]]))
      return { key, writer: { lane, first: true } }
    })),
    ({ key }) => opening.withPermits(1)(Effect.gen(function* () {
      const holding = (yield* Ref.get(holdings)).get(key)
      if (holding === undefined) return
      if (holding.handles > 1) {
        yield* Ref.update(holdings, (all) => new Map([...all, [key, { ...holding, handles: holding.handles - 1 }]]))
        return
      }
      yield* Ref.update(holdings, (all) => new Map([...all].filter(([other]) => other !== key)))
      yield* removeQuietly(holding.file)
    })),
  ).pipe(Effect.map(({ writer }) => writer))
